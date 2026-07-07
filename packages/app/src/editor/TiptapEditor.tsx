import type { HocuspocusProvider } from '@hocuspocus/provider';
import {
  sharedExtensions as coreExtensions,
  deriveIconColor,
  evictStaleEntries,
  FLASH_DEBOUNCE_MS,
  FLASH_DURATION_MS,
  hasNewEntries,
  MarkdownManager,
} from '@inkeep/open-knowledge-core';
import { type AnyExtension, Editor, type EditorOptions, Extension } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import Placeholder from '@tiptap/extension-placeholder';
import { EditorContent } from '@tiptap/react';
import { initProseMirrorDoc, yCursorPlugin, ySyncPluginKey } from '@tiptap/y-tiptap';
import { type FC, use, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SelectionAnnouncer } from '@/components/editor/SelectionAnnouncer';
import { clearRenameSnapshot, parkTiptapEditor, peekRenameSnapshot } from './editor-cache';
import { InteractionLayerView } from './interaction-layer';
import { getInteractionLayer } from './interaction-layer-host';

// Module-level WeakMap storing the `performance.now()` anchor captured in
// `onBeforeCreate` and consumed in `onCreate`. Scoped per-Editor instance so
// StrictMode double-invoke and provider-pool churn don't cross-contaminate
// measurements. WeakMap auto-GCs when the Editor is destroyed.
const editorCtorStartTimes = new WeakMap<object, number>();

import { OUTLINE_NAV_EVENT, type OutlineNavDetail } from '@/components/OutlinePanel';
import { anchorFromHash } from '@/lib/doc-hash';
import { mark } from '@/lib/perf';
import { wrapExtensionsWithTiming } from '@/lib/perf/cold-mount-instrumentation';
import type { SidebarDragPayload } from '@/lib/sidebar-drag';
import { useIdentity } from '../presence/identity';
import { registerEditor, unregisterEditor } from './active-editor';
import { buildAwarenessUser } from './awareness-user';
import { bindingStalenessGuardPlugin, type WedgeDetail } from './binding-staleness-guard';
import { BubbleMenuBar } from './bubble-menu/BubbleMenuBar';
import {
  createClipboardHtmlSerializer,
  createClipboardTextSerializer,
  createHandleDrop,
  createHandlePaste,
} from './clipboard/index.ts';
import { useDocumentContext } from './DocumentContext';
import { setEditorDocName } from './extensions/doc-context.ts';
import { setEditorSourceMode } from './extensions/editor-mode-context.ts';
import { FrozenTableHeaders } from './extensions/frozen-table-headers.ts';
import { sharedExtensions } from './extensions/shared.ts';
import { uploadDecorationPlugin } from './image-upload/index.ts';
import { getMountId } from './mount-id-registry';
import { mountTiptapEditorPromise } from './mount-promise';
import { markUserTyping } from './observers';
import { publishSelectionContext, selectionSnapshotFromWysiwyg } from './selection-context';
import {
  publishSelectionStats,
  SELECTION_STATS_DEBOUNCE_MS,
  selectionStatsFromWysiwyg,
} from './selection-stats';
import { createSidebarAwareHandleDrop, openSidebarDropPayload } from './sidebar-drop';
import { TableCellHandles } from './table-controls/TableCellHandles';
import { attachTypingBurstDetector } from './typing-burst-detector';
import { getEditorView } from './utils/get-editor-view';
import { walkCurrencyExtension } from './walk-currency-extension';

/**
 * Custom cursor renderer. Agents do not publish per-doc awareness, so this
 * renderer only ever sees humans. `AwarenessUser.type` narrows to `'human'`
 * statically; an explicit `user.type === 'agent'` short-circuit would be
 * unreachable.
 */
function renderCursor(user: Record<string, string>): HTMLElement {
  const cursor = document.createElement('span');
  cursor.classList.add('collaboration-cursor__caret');
  cursor.style.borderColor = user.color;

  const label = document.createElement('div');
  label.classList.add('collaboration-cursor__label');
  label.style.backgroundColor = user.color;
  label.style.color = deriveIconColor(user.color);
  label.textContent = user.name;
  cursor.append(label);

  return cursor;
}

/**
 * Flash state — observable programmatically via `window.__agentFlashState`.
 * Tests can poll this, listen for the `agent-flash` / `agent-flash-end` events,
 * or assert on the wrapper's `data-agent-flash-state` attribute.
 */
interface AgentFlashState {
  /** 'idle' (no flash active), 'editing' (flash animation running), 'settled' (just finished) */
  state: 'idle' | 'editing' | 'settled';
  /** Monotonic counter — increments on every flash trigger (useful for debounce tests) */
  count: number;
  /** Unix ms timestamp of the last flash trigger */
  lastFiredAt: number | null;
  /** 'append' flashes last N blocks; 'prepend' flashes first N blocks */
  position: 'append' | 'prepend';
  /** Agent ID that triggered the flash */
  lastAgentId: string | null;
}

const INITIAL_FLASH_STATE: AgentFlashState = {
  state: 'idle',
  count: 0,
  lastFiredAt: null,
  position: 'append',
  lastAgentId: null,
};

const ANCHOR_SCROLL_MAX_ATTEMPTS = 100;
const ANCHOR_SCROLL_RETRY_MS = 100;
const ANCHOR_SCROLL_FOLLOW_UP_ATTEMPTS = 3;
const ANCHOR_SCROLL_FOLLOW_UP_MS = 250;

interface TiptapEditorProps {
  provider: HocuspocusProvider;
  placeholder?: string;
  /**
   * Whether the active doc's editor surface is the source view. TiptapEditor
   * stays mounted underneath the source surface (CSS-hidden) per the editor
   * cache pattern, but we publish the mode the user is actually using —
   * keeps presence consistent with what they see. Single mode-publication
   * site avoids the race between two editor effects writing the same field.
   */
  isSourceMode: boolean;
  /**
   * Per-Activity exclusive portal target for `<EditorContent>`. Owned by
   * the parent `ActivityEntry` (stable across this `TiptapEditor`'s remount)
   * — `<EditorContent>` is rendered into this target via `React.createPortal`,
   * so `editor.view.dom.parentNode` is structurally per-Activity private.
   *
   * Why portaled: `@tiptap/react`'s `PureEditorContent.componentDidMount.init()`
   * spread-appends every sibling of `view.dom` into the EditorContent refDiv.
   * When two Activities transiently share a DOM ancestor at the moment that
   * primitive fires, the vacuum drags foreign editors' view.dom into the
   * active editor's wrapper — the cross-doc bleed surface family. A
   * per-Activity portal target structurally prevents foreign editors from
   * ever being siblings of this editor's view.dom.
   */
  portalTarget: HTMLElement;
}

/** Clipboard primitives shared by both legacy and Pattern D paths. */
type ClipboardState = ReturnType<typeof buildClipboardState>;

// @tiptap/react 3.22.3 stores the EditorContent React binding on these
// Editor instance fields. This repair is defense-in-depth after rename pool
// cleanup; TipTap upgrades must verify the fields still exist.
type EditorContentBindingState = Editor & {
  contentComponent: unknown | null;
  isEditorContentInitialized: boolean;
};

function hasEditorContentBindingState(editor: Editor): editor is EditorContentBindingState {
  return 'contentComponent' in editor && 'isEditorContentInitialized' in editor;
}

function repairDetachedEditorContent(editor: Editor, portalTarget: HTMLElement): boolean {
  const view = getEditorView(editor);
  if (!view || portalTarget.contains(view.dom)) return false;

  if (!hasEditorContentBindingState(editor)) {
    console.warn(
      '[TiptapEditor] TipTap EditorContent binding fields missing; detached editor repair skipped',
    );
    return false;
  }

  const editorWithContent = editor;
  if (editorWithContent.contentComponent == null) return false;

  try {
    view.setProps({ nodeViews: {} });
  } catch {
    // Best effort. The remounted EditorContent will recreate node views.
  }
  editorWithContent.contentComponent = null;
  editorWithContent.isEditorContentInitialized = false;
  return true;
}

/**
 * Mapping shape used by `ySyncPlugin`'s mapping option for the pre-warm path.
 * Derived from `initProseMirrorDoc`'s return type rather than imported as a
 * named type — `ProsemirrorMapping` is not part of `@tiptap/y-tiptap`'s
 * public re-export surface, only its sync-plugin module's deep export. The
 * `ReturnType` indirection follows the package's public API so version
 * upgrades that refine the mapping shape propagate automatically.
 */
type ProsemirrorMapping = ReturnType<typeof initProseMirrorDoc>['mapping'];

function buildClipboardState() {
  const mdManager = new MarkdownManager({ extensions: coreExtensions });
  return {
    mdManager,
    text: createClipboardTextSerializer({ mdManager }),
    html: createClipboardHtmlSerializer({ mdManager }),
    paste: createHandlePaste({ mdManager }),
    // Drop-side dispatcher mirrors paste so dragged text/HTML payloads
    // flow through the same branch tree (markdown-first tiebreak,
    // vscode-data, gfm, html, plaintext) instead of PM's default
    // text/plain insertion. File drops still route through
    // FileHandler.onDrop in `extensions/shared.ts` — `createHandleDrop`
    // returns false when `dataTransfer.files` is non-empty.
    drop: createHandleDrop({ mdManager }),
  };
}

interface BuildEditorOptionsArgs {
  provider: HocuspocusProvider;
  placeholder?: string;
  clipboard: ClipboardState;
  ctorStart: number;
  /**
   * Pre-warm mapping. When supplied, forwarded to Collaboration's
   * `ySyncOptions.mapping` so y-tiptap's `ySyncPlugin` view callback skips
   * the on-mount `_forceRerender()` call. The caller
   * must populate the mapping AND inject `content` from one walk keyed to
   * the editor's own schema before the view binds — both happen inside the
   * wrapped `onBeforeCreate` of `buildPatternDConstructorOptions`, the
   * canonical (and only) producer. Pattern D path only — legacy path leaves
   * this undefined.
   *
   * `@tiptap/extension-collaboration` v3.22.3 already forwards
   * `ySyncOptions.mapping` via `{ ...this.options.ySyncOptions, onFirstRender }`,
   * so the OK-side wire-up here is sufficient — no patch file needed.
   *
   * Supplying the mapping also wires `walkCurrencyExtension` alongside it,
   * which enforces the pair's view-bind currency precondition at mount (a
   * fragment change in the construct→mount gap invalidates the pair via
   * `binding._forceRerender()` — see `walk-currency-extension.ts`).
   */
  prebuiltMapping?: ProsemirrorMapping;
  /**
   * Wedge-recycle callback for the binding staleness guard. When the guard
   * detects a wedged Y→PM apply, this is invoked (once per
   * editor instance, rate-capped per docName) so the caller can recycle the
   * pool entry. Optional so option-building stays unit-testable without a
   * DocumentContext; the guard's publication gate protects either way.
   */
  onWedged?: (detail: WedgeDetail) => void;
  onSidebarDrop?: (payload: SidebarDragPayload) => void;
}

/**
 * The Collaboration extension and its pre-warm guard, derived together from a
 * single `prebuiltMapping` decision.
 *
 * Forwarding `prebuiltMapping` into `ySyncOptions.mapping` makes ySyncPlugin
 * skip its on-mount `_forceRerender()`, which is exactly the condition
 * `walkCurrencyExtension` exists to make safe. These are semantically ONE
 * decision: a mapping handed to the binding without the currency guard
 * silently reintroduces the construct→mount-gap CRDT-erasure class.
 * `buildPrewarmBoundCollaboration` is the only producer of the
 * mapping-bearing Collaboration config, and it cannot produce that config
 * without also producing `guard` from the same branch — so a future refactor
 * adjusting the mapping wire-up cannot ship the mapping unguarded.
 *
 * `collaboration` and `guard` are returned separately (rather than one array)
 * only so the caller can keep `walkCurrency` last in the extension list,
 * preserving its plugin-view init order among the default-priority extensions
 * (TipTap's stable priority sort keeps equal-priority extensions in array
 * order; walkCurrency must stay after `bindingStalenessGuard`).
 */
interface PrewarmBoundCollaboration {
  collaboration: AnyExtension;
  guard: AnyExtension[];
}

function buildPrewarmBoundCollaboration(
  provider: HocuspocusProvider,
  prebuiltMapping: ProsemirrorMapping | undefined,
): PrewarmBoundCollaboration {
  // Forward the pre-warm mapping via ySyncOptions when the deferred-mount
  // path supplies one. The Map arrives initially EMPTY at options-build time
  // and is populated in place by the construct-time walk inside
  // `buildPatternDConstructorOptions`'s wrapped `onBeforeCreate` — safe
  // because TipTap's ExtensionManager `plugins` getter is lazy until
  // `editor.mount()`, so
  // ySyncPlugin captures the (by then fully populated) reference only at
  // mount. ySyncPlugin's view callback skips `_forceRerender()` when mapping
  // is non-null,
  // moving the Y→PM walk out of the mount-task and into the construct-task.
  // `@tiptap/extension-collaboration@3.22.3` already does
  // `{ ...this.options.ySyncOptions, onFirstRender }` so the spread carries
  // `mapping` end-to-end without a patch file.
  if (!prebuiltMapping) {
    return { collaboration: Collaboration.configure({ document: provider.document }), guard: [] };
  }
  return {
    collaboration: Collaboration.configure({
      document: provider.document,
      ySyncOptions: { mapping: prebuiltMapping },
    }),
    // Walk-currency enforcement is produced from the SAME branch that hands
    // the pre-warm mapping to ySyncPlugin, so a prebuiltMapping/content pair
    // can never reach the binding without its view-bind currency check (a
    // fragment change in the construct→mount gap invalidates the pair via
    // `binding._forceRerender()` — see walk-currency-extension.ts).
    guard: [
      walkCurrencyExtension({
        fragment: provider.document.getXmlFragment('default'),
        docName: provider.configuration.name ?? '',
      }),
    ],
  };
}

/**
 * Build the editor's extension list (without the timing wrap). Pure structural
 * helper kept separate from `buildEditorOptions` so the wiring arms are
 * observable without unwrapping the `wrapExtensionsWithTiming` traversal.
 *
 * Exported for tests (the walk-currency wiring arms are pinned on this
 * list); production callers go through `buildEditorOptions` /
 * `buildPatternDConstructorOptions`. No production caller derives a
 * standalone schema from this list: the Pattern D pre-warm walk is keyed to
 * the editor's own `Schema` instance inside the wrapped `onBeforeCreate`
 * (see `buildPatternDConstructorOptions`) — ProseMirror content matching is
 * NodeType-identity-based, so a walk against any other `Schema` instance
 * yields mapping nodes the first incremental rebuild silently drops.
 */
export function buildExtensionList(args: BuildEditorOptionsArgs): AnyExtension[] {
  const { provider, placeholder, prebuiltMapping, onWedged } = args;
  // The mapping-forwarding and its currency guard are one decision — derive
  // both from `prebuiltMapping` in a single call so the mapping cannot be
  // wired to the binding without arming the guard.
  const { collaboration, guard } = buildPrewarmBoundCollaboration(provider, prebuiltMapping);
  return [
    // Configure docName-aware extensions before construction. Link extensions
    // use it for resolved/folder/unresolved states; jsxComponent uses it to
    // normalize doc-relative media src values while rendering raw JSX/MDX.
    ...sharedExtensions.map((ext) => {
      if (ext.name === 'link' || ext.name === 'wikiLink' || ext.name === 'jsxComponent') {
        return ext.configure({ docName: provider.configuration.name ?? '' });
      }
      return ext;
    }),
    Placeholder.configure({
      placeholder: placeholder ?? "Type '/' for commands",
      showOnlyCurrent: true,
    }),
    // Collaboration (with `ySyncOptions.mapping` forwarded when a pre-warm
    // mapping is supplied) — paired with its currency guard below via
    // `buildPrewarmBoundCollaboration`.
    collaboration,
    Extension.create({
      name: 'imageUploadDecoration',
      addProseMirrorPlugins() {
        return [uploadDecorationPlugin];
      },
    }),
    // Use yCursorPlugin from @tiptap/y-tiptap directly (same module
    // as Collaboration v3) to avoid ySyncPluginKey mismatch.
    Extension.create({
      name: 'collaborationCursor',
      addProseMirrorPlugins() {
        const awareness = provider.awareness;
        if (!awareness) {
          throw new Error(
            '[TiptapEditor] HocuspocusProvider has no awareness instance — cursor plugin cannot initialize',
          );
        }
        return [
          yCursorPlugin(awareness, {
            cursorBuilder: renderCursor,
          }),
        ];
      },
    }),
    // Staleness guard for the y-sync binding: gates PM→Y
    // publication while the binding's Y→PM apply half is wedged and reports
    // the wedge so the pool entry can be recycled. Binds the same fragment
    // Collaboration binds (provider.document field 'default').
    Extension.create({
      name: 'bindingStalenessGuard',
      addProseMirrorPlugins() {
        return [
          bindingStalenessGuardPlugin({
            fragment: provider.document.getXmlFragment('default'),
            docName: provider.configuration.name ?? '',
            onWedged: onWedged ?? (() => {}),
          }),
        ];
      },
    }),
    // Walk-currency enforcement, produced together with the mapping-bearing
    // `collaboration` above by `buildPrewarmBoundCollaboration`. Kept last so
    // its plugin-view init order among the default-priority extensions is
    // unchanged (after `bindingStalenessGuard`); empty when no pre-warm
    // mapping was supplied.
    ...guard,
    FrozenTableHeaders,
  ];
}

/**
 * Editor constructor options shared by the legacy (auto-mount) and Pattern D
 * (deferred-mount) paths. The only thing that varies between paths is HOW
 * `element` is passed:
 *   - Legacy: `new Editor({ element: el, ...buildEditorOptions(...) })` — auto-mounts onto `el`
 *   - Pattern D: `new Editor({ element: null, ...buildEditorOptions(...) })` — explicit null
 *     bypasses auto-mount; `mount-promise.ts` calls `editor.mount(transient)`
 *     after the yield-point.
 *
 * Pattern D MUST pass `element: null` explicitly (NOT omit the field) — full
 * source rationale at `ConstructedTiptapBundle.editor` in `mount-promise.ts`.
 */
function buildEditorOptions(args: BuildEditorOptionsArgs): Partial<EditorOptions> {
  const { provider, clipboard, ctorStart } = args;
  return {
    onBeforeCreate: ({ editor }) => {
      editorCtorStartTimes.set(editor, ctorStart);
    },
    onCreate: ({ editor }) => {
      // Attach the live editor view to the clipboard HTML serializer
      // so the live-DOM walker can call view.nodeDOM(pos) +
      // getComputedStyle. Pre-attach calls fall through to the
      // markdown→HTML pipeline; the walker is a no-op without a view.
      clipboard.html.setView(editor.view);
      const start = editorCtorStartTimes.get(editor);
      editorCtorStartTimes.delete(editor);
      if (start == null) return;
      const now = performance.now();
      mark(
        'ok/editor/create-tiptap',
        {
          docName: provider.configuration.name ?? 'unknown',
          ytextLength: provider.document.getText('source').length,
        },
        { startTime: start, duration: Math.max(0, now - start) },
      );
    },
    editorProps: {
      attributes: {
        class: 'pt-4 pb-4 h-full',
      },
      clipboardTextParser: (text, _context, _plain, view) => {
        const json = clipboard.mdManager.parse(text);
        const node = view.state.schema.nodeFromJSON(json);
        // biome-ignore lint/suspicious/noExplicitAny: TipTap's clipboardTextParser expects a Slice-like return but ProseMirror Fragment works at runtime; no public type expresses the union
        return node.content as any;
      },
      clipboardTextSerializer: (slice, view) => clipboard.text(slice, view),
      clipboardSerializer: clipboard.html.serializer,
      handlePaste: (view, event) => clipboard.paste(view, event),
      handleDrop: createSidebarAwareHandleDrop(clipboard.drop, args.onSidebarDrop),
    },
    // Wrap every extension's lifecycle hooks so each emits an
    // `ok/cold/ext-{name}-{hook}` span. PROD short-circuits to
    // identity. Wrap the FINAL list — sharedExtensions (configured
    // for `link`'s docName) plus the per-mount Placeholder /
    // Collaboration / imageUploadDecoration / collaborationCursor.
    extensions: wrapExtensionsWithTiming(buildExtensionList(args)),
  };
}

interface BuildPatternDConstructorOptionsArgs {
  provider: HocuspocusProvider;
  placeholder?: string;
  clipboard: ClipboardState;
  ctorStart: number;
  onWedged?: (detail: WedgeDetail) => void;
  onSidebarDrop?: (payload: SidebarDragPayload) => void;
}

/**
 * Pattern D `new Editor(...)` options. The `element: null` literal type is
 * load-bearing — it forbids the field from being silently dropped or swapped
 * to a non-null default by a future refactor. Source rationale at
 * `ConstructedTiptapBundle.editor` in `mount-promise.ts`: omitting `element`
 * falls through to TipTap's default `document.createElement('div')`, which auto-mounts and turns
 * `mount-promise.ts`'s subsequent `editor.mount(transient)` into a *second*
 * mount, doubling EditorView construction cost.
 */
type PatternDConstructorOptions = Partial<EditorOptions> & { element: null };

/**
 * Build the `new Editor(...)` constructor options for the Pattern D path.
 * Extracted from the construct closure inside `TiptapEditor` so unit tests
 * can pin the load-bearing invariants:
 *   - `element: null` ALWAYS present (not undefined, not omitted) so TipTap's
 *     auto-mount stays bypassed.
 *   - Pre-warm: the wrapped `onBeforeCreate` walks the Y.XmlFragment via
 *     `initProseMirrorDoc(fragment, editor.schema)` — the editor's OWN
 *     `Schema` instance — populating the Collaboration-handed mapping in
 *     place and injecting `editor.options.content` before TipTap parses it.
 *     ProseMirror content matching is NodeType-identity-based: a mapping
 *     built against any other `Schema` instance has its cached nodes
 *     silently dropped by the first incremental rebuild's `tr.replace`
 *     fitter (user-visible content loss that then propagates to the CRDT).
 *     Keying the walk to `editor.schema` is the only Schema in this path,
 *     so a foreign-schema pair is unrepresentable here.
 *
 * Constructor-order contract this relies on:
 * `createSchema()` runs, then `beforeCreate` is emitted BEFORE
 * `createDoc()` consumes `options.content`, and the
 * ExtensionManager `plugins` getter that hands `ySyncOptions.mapping` to
 * ySyncPlugin is lazy until `editor.mount()`. Re-verify this
 * ordering on every @tiptap/core bump — the construct-time pins in
 * `TiptapEditor.test.tsx` go red on any reorder.
 *
 * Each returned options object is SINGLE-USE: its `onBeforeCreate` closes
 * over its own mapping Map, so reusing one options object across two
 * `new Editor(...)` calls would cross-contaminate the pre-warm pair. The
 * only production caller builds a fresh options object per `construct()`
 * invocation.
 *
 * Exported for tests; production callers should use the construct closure
 * inside `TiptapEditor` rather than re-deriving the options.
 */
export function buildPatternDConstructorOptions(
  args: BuildPatternDConstructorOptionsArgs,
): PatternDConstructorOptions {
  const { provider, placeholder, clipboard, ctorStart, onWedged, onSidebarDrop } = args;
  const fragment = provider.document.getXmlFragment('default');
  // Stable Map wired to Collaboration's `ySyncOptions.mapping` via
  // `buildPrewarmBoundCollaboration`. Starts empty; the wrapped
  // `onBeforeCreate` below fills it in place once the editor's schema
  // exists. No consumer reads it before mount (lazy `plugins` getter).
  const prebuiltMapping: ProsemirrorMapping = new Map();
  const baseOptions = buildEditorOptions({
    provider,
    placeholder,
    clipboard,
    ctorStart,
    prebuiltMapping,
    onWedged,
    onSidebarDrop,
  });
  const baseOnBeforeCreate = baseOptions.onBeforeCreate;
  return {
    ...baseOptions,
    onBeforeCreate: (props) => {
      baseOnBeforeCreate?.(props);
      const { editor } = props;
      // The pre-warm walk, keyed to the editor's own Schema instance (the
      // only point where both the fragment and that schema exist). Runs
      // synchronously inside `new Editor(...)`, so the walk stays on the
      // construct task exactly as before.
      const { doc, mapping } = initProseMirrorDoc(fragment, editor.schema);
      mapping.forEach((node, key) => {
        prebuiltMapping.set(key, node);
      });
      editor.options.content = doc.toJSON();
    },
    element: null,
  };
}

/**
 * TiptapEditor — Pattern D (Suspense + `use(promise)`) mount path. The only
 * editor mount path in the app; precedent #18(d) substrate is the production
 * default since the rollout retirement.
 *
 * Editor reference is stable from render 1: `use(mountTiptapEditorPromise(...))`
 * suspends until the editor is constructed AND mounted (mount-promise.ts owns
 * `await scheduler.yield()` → `new Editor({element: null})` →
 * `await scheduler.yield()` → `editor.mount(transient)`).
 * `<EditorContent>` only ever sees a fully-mounted editor — no null-state hop,
 * no `EditorContentWithKey` random-key cascade.
 *
 * Suspense fallback: the parent `EditorActivityPool` already wraps with
 * `<Suspense fallback={<EditorSkeleton/>}>` (same skeleton precedent #18(d)
 * source-mode-defer uses); user sees one atomic skeleton-to-editor transition.
 *
 * Mount failure: promise rejects → `use()` throws → `DocumentErrorBoundary`
 * catches → "Try again" recycles cache.
 *
 * Cancellation: `parkTiptapEditor(entry)` on unmount → mount-promise cache is
 * preserved across V2-admit park (so warm reopen returns the same resolved
 * promise reference and `use()` short-circuits without Suspense). On
 * V2-refuse park or kill-switch, `invalidateMountPromise(docName)` aborts
 * any in-flight construction via AbortController.
 *
 * StrictMode: editor reference is stable across the dev-mode double-invoke —
 * the V2 cache HIT path on remount returns the same parked entry, and
 * mount-promise's module-level cache returns the same promise reference within
 * a single mount lifecycle.
 */
export const TiptapEditor: FC<TiptapEditorProps> = ({
  provider,
  placeholder,
  isSourceMode,
  portalTarget,
}) => {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const flashStateRef = useRef(INITIAL_FLASH_STATE);
  const identity = useIdentity();
  const { principal, activeDocName, recycleDocument, openTarget } = useDocumentContext();
  const docName = provider.configuration.name ?? '';

  const [clipboard] = useState(buildClipboardState);

  // Construct closure captured once per mount via useState lazy init.
  // mount-promise.ts owns the deferred `editor.mount(transient)` call after
  // the yield-point. Options building (element: null + pre-warm wiring)
  // is delegated to `buildPatternDConstructorOptions` so the load-bearing
  // invariants are unit-testable in isolation.
  //
  // Provider stability invariant: `provider` is captured into the closure once
  // and is NOT in a deps array. This is safe because EditorActivityPool
  // mounts each TiptapEditor with
  // `key={`${entry.docName}-${String(isNewDoc)}-${entry.poolEventId}`}`,
  // and the pool entry holds a single provider for its lifetime — a provider
  // recycle (DocumentErrorBoundary "Try again", pool eviction, binding wedge
  // recovery) creates a new entry with a fresh poolEventId, which changes the
  // key and remounts TiptapEditor with a fresh closure. So provider identity
  // cannot change without a remount. If the pool's keying ever decouples from
  // provider identity, this closure capture would silently use a stale
  // provider — re-evaluate then.
  const [construct] = useState(() => () => {
    const ctorStart = performance.now();
    const tipTapEditor = new Editor(
      buildPatternDConstructorOptions({
        provider,
        placeholder,
        clipboard,
        ctorStart,
        // Wedged Y→PM apply: the EditorView holds a stale PM
        // replica it can no longer reconcile in place — recycle the pool
        // entry so a fresh provider/editor pair derives from current Y
        // state (same recovery path as DocumentErrorBoundary "Try again").
        // `recycleDocument`/`docName` ride the provider-stability closure
        // capture documented below: recycle remounts with a fresh closure.
        onWedged: ({ externalSeq, appliedSeq }) => {
          mark('ok/editor/binding-wedge-recycle', { docName, externalSeq, appliedSeq });
          recycleDocument(docName);
        },
        onSidebarDrop: (payload) => {
          openSidebarDropPayload(payload, openTarget);
        },
      }),
    );
    return {
      editor: tipTapEditor,
      ydoc: provider.document,
      ytext: provider.document.getText('source'),
      provider,
    };
  });

  // Bytes from Y.Text length is cheap O(1); view-count is set to 0 so the
  // view-count gate (threshold 50) is never hit while the bytes gate stays
  // live.
  const bytes = provider.document.getText('source').length;
  const sizeStats = { viewCount: 0, bytes };

  // Suspense-async substrate (extends precedent #18(d)). The promise resolves
  // with the V2 cache entry once construction + yield + mount complete;
  // rejection propagates to DocumentErrorBoundary via use().
  //
  // mountId derivation: adopt the EditorActivityPool-registered id when
  // present so prewarm-then-click and pool-warmth correlate across the
  // pool→mount boundary. Fall back to a fresh UUID when the pool effect
  // hasn't run yet (rare race during first-render of a doc that bypasses
  // the pool's mount-list — e.g. direct navigation before the pool's
  // promote effect lands).
  const mountId = getMountId(docName) ?? crypto.randomUUID();
  const entry = use(mountTiptapEditorPromise({ docName, mountId, construct, sizeStats }));
  const editor = entry.editor;

  // Park on unmount. parkTiptapEditor invokes invalidateMountPromise which
  // clears mount-promise's cache entry; the next mount on this docName
  // re-probes V2 cache (cache HIT returns the parked entry, triggering the
  // reparent path). V2 cache park is idempotent so StrictMode's double-mount
  // cleanup is safe.
  useEffect(() => {
    return () => {
      parkTiptapEditor(entry);
    };
  }, [entry]);

  return (
    <TiptapEditorChrome
      provider={provider}
      isSourceMode={isSourceMode}
      docName={docName}
      activeDocName={activeDocName}
      identity={identity}
      principal={principal}
      editor={editor}
      wrapperRef={wrapperRef}
      flashStateRef={flashStateRef}
      portalTarget={portalTarget}
    />
  );
};

interface TiptapEditorChromeProps {
  provider: HocuspocusProvider;
  isSourceMode: boolean;
  docName: string;
  activeDocName: string | null;
  identity: ReturnType<typeof useIdentity>;
  principal: ReturnType<typeof useDocumentContext>['principal'];
  editor: Editor;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  flashStateRef: React.RefObject<AgentFlashState>;
  portalTarget: HTMLElement;
}

/**
 * Editor chrome. Owns:
 *  - editor-attached side effects (doc-name registration, active-editor
 *    registration, markUserTyping listeners, agent-flash observer,
 *    anchor-scroll, outline-nav, presence publishing)
 *  - the wrapper JSX with BubbleMenuBar / TableCellHandles / EditorContent /
 *    SelectionAnnouncer / InteractionLayerView
 *
 * Receives `editor` guaranteed-non-null from `TiptapEditor` (Suspense gates
 * render until mount-promise resolves).
 */
const TiptapEditorChrome: FC<TiptapEditorChromeProps> = ({
  provider,
  isSourceMode,
  docName,
  activeDocName,
  identity,
  principal,
  editor,
  wrapperRef,
  flashStateRef,
  portalTarget,
}) => {
  // Imperatively attach the per-Activity portal target as a DOM child of
  // the portal slot below. The portal slot is a JSX-rendered placeholder
  // sitting at the exact DOM position the inline `<EditorContent>` used
  // to occupy (between `TableCellHandles` and `SelectionAnnouncer` in
  // the `.tiptap-editor` grid container) so the post-fix DOM order
  // matches the pre-fix order. Both the slot and the portal target use
  // `display: contents` so neither contributes a layout box — the
  // `<EditorContent>` refDiv inside acts as the effective grid child of
  // `.tiptap-editor`, carrying `grid-column: content` via its explicit
  // `.tiptap-editor-portal-content` class (the rule in `globals.css`). This keeps the post-portal scroll
  // geometry byte-identical to the pre-portal inline-render and preserves
  // `docs-open.e2e.ts` F1 warm-nav scrollTop restoration.
  //
  // The portal target itself is owned by `ActivityEntry`'s `useState`
  // (per-Activity, stable across this `TiptapEditor`'s remount on
  // `${docName}-${isNewDoc}` key change). The slot is React-rendered so
  // it gets re-created on TiptapEditor remount, but the imperatively-
  // appended portal target survives — view.dom rides along inside.
  //
  // Cleanup detaches the target on this editor's unmount. The editor's
  // own unmount path (`parkTiptapEditor` moves view.dom into the
  // per-entry parking node; mount-promise's V2 cache HIT branch on
  // remount calls `reparentTiptapDom` to move view.dom into a fresh
  // transient) handles view.dom's reparenting; leaving the target empty
  // and detached is safe.
  const portalSlotRef = useRef<HTMLDivElement | null>(null);
  const [editorContentRevision, setEditorContentRevision] = useState(0);
  useLayoutEffect(() => {
    const slot = portalSlotRef.current;
    if (!slot) return;
    slot.appendChild(portalTarget);
    return () => {
      if (portalTarget.parentNode === slot) {
        slot.removeChild(portalTarget);
      }
    };
  }, [portalTarget]);

  useEffect(() => {
    if (repairDetachedEditorContent(editor, portalTarget)) {
      setEditorContentRevision((revision) => revision + 1);
    }
  }, [editor, portalTarget]);
  // Register this editor's doc name in the per-editor WeakMap so
  // `image-upload/uploadAndInsert(editor, ...)` can resolve it safely —
  // no module-level singleton to race over when multiple editors are
  // mounted concurrently under an Activity pool.
  useEffect(() => {
    const docName = provider.configuration.name ?? null;
    setEditorDocName(editor, docName);
    return () => {
      setEditorDocName(editor, null);
    };
  }, [editor, provider]);

  // Register the TipTap editor instance in the module-level active-editor map
  // so active-document UI (find/replace) can target only the foreground doc.
  // In DEV, DocumentContext also exposes this registry through
  // `window.__activeEditor` so Playwright can poll `editor.state.selection`
  // directly and avoid DOM-selection races.
  //
  // `unregisterEditor` matches on the editor ref so the StrictMode double-
  // invoke ordering (register-A, register-B, cleanup-A) doesn't leave the
  // registry empty.
  useEffect(() => {
    const docName = provider.configuration.name;
    if (!docName) return;
    registerEditor(docName, editor);
    return () => unregisterEditor(docName, editor);
  }, [editor, provider]);

  // Publish selection-scoped stats so the footer can scope its counts to the
  // current selection. Debounced because selection events fire rapidly during
  // drag-select; cleared to null on unmount so a closed tab leaves no entry.
  useEffect(() => {
    const docName = provider.configuration.name;
    if (!docName) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const publish = () => {
      timer = null;
      publishSelectionStats(docName, 'wysiwyg', selectionStatsFromWysiwyg(editor));
      publishSelectionContext(docName, 'wysiwyg', selectionSnapshotFromWysiwyg(editor, docName));
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(publish, SELECTION_STATS_DEBOUNCE_MS);
    };
    publish();
    editor.on('selectionUpdate', schedule);
    editor.on('update', schedule);
    return () => {
      if (timer) clearTimeout(timer);
      editor.off('selectionUpdate', schedule);
      editor.off('update', schedule);
      publishSelectionStats(docName, 'wysiwyg', null);
      publishSelectionContext(docName, 'wysiwyg', null);
    };
  }, [editor, provider]);

  // Per-burst typing detector. The whole module + its wire-site are dead
  // code in prod via the dead-branch gate below — Vite constant-folds
  // `import.meta.env.PROD` and DCEs the `attachTypingBurstDetector`
  // reference, the import, and the entire module. The bundle-check
  // assertion greps prod chunks for the detector's sentinel string to
  // detect regressions.
  useEffect(() => {
    if (import.meta.env.PROD) return;
    if (!editor) return;
    const docName = provider.configuration.name;
    if (!docName) return;
    const mountId = getMountId(docName);
    if (!mountId) return;
    const sampler = attachTypingBurstDetector({
      mode: 'WYSIWYG',
      docName,
      mountId,
    });
    type TxArg = {
      transaction: { docChanged: boolean; getMeta: (key: typeof ySyncPluginKey) => unknown };
    };
    const onTransaction = (arg: unknown) => {
      const transaction = (arg as TxArg).transaction;
      if (!transaction.docChanged) return;
      // Origin gate: sync transactions injected by y-prosemirror carry
      // the ySyncPluginKey meta. Reject those — only true user input
      // should drive the burst.
      if (transaction.getMeta(ySyncPluginKey)) return;
      // Substrate-coarse durationMs/charsDelta — see typing-burst-detector.ts.
      sampler.recordUserInput(0, 1);
    };
    editor.on('transaction', onTransaction);
    return () => {
      editor.off('transaction', onTransaction);
      sampler.detach();
    };
  }, [editor, provider]);

  useEffect(() => {
    // TipTap v3's `editor.view` is a proxy that throws when accessed before
    // the underlying `editorView` is mounted — e.g. during an Activity
    // visible→hidden→visible cycle, a DocumentErrorBoundary retry that
    // recycles the pool entry, or any race where React runs a passive
    // effect on an editor whose view is mid-creation. We subscribe to the
    // editor's 'create' event so the listener attachment happens after the
    // view is guaranteed present. If the editor is already created by the
    // time this effect runs (common path), we attach immediately.
    // Required for the retry flow + any Activity unhide reconnect.
    const mark = () => markUserTyping();
    let attachedDom: HTMLElement | null = null;
    const attach = () => {
      if (attachedDom || editor.isDestroyed) return;
      const view = getEditorView(editor);
      if (!view) return;
      attachedDom = view.dom;
      attachedDom.addEventListener('keydown', mark);
      attachedDom.addEventListener('paste', mark);
      attachedDom.addEventListener('drop', mark);
      attachedDom.addEventListener('cut', mark);
    };
    const detach = () => {
      if (!attachedDom) return;
      attachedDom.removeEventListener('keydown', mark);
      attachedDom.removeEventListener('paste', mark);
      attachedDom.removeEventListener('drop', mark);
      attachedDom.removeEventListener('cut', mark);
      attachedDom = null;
    };
    // `getEditorView` returns undefined pre-mount; truthy check confirms the
    // underlying ProseMirror EditorView is present so `attach()` can run now.
    const isMounted = !!getEditorView(editor);
    if (isMounted) {
      attach();
    } else {
      editor.on('create', attach);
    }
    return () => {
      editor.off('create', attach);
      detach();
    };
  }, [editor]);

  // Rename-snapshot consumption — one-shot, on the editor's first `'create'`.
  // The rename snapshot (HTML + scrollTop + selection, see editor-cache.ts)
  // is keyed by docName; this effect consumes it in two steps:
  //
  //   1. Restore the captured cursor selection, if any. Positions are
  //      clamped to the new doc's content.size so a brief size mismatch
  //      during initial CRDT hydration degrades to default selection
  //      rather than throwing (the rename spine writes the same bytes
  //      back, so positions are expected to match — clamping is defensive).
  //   2. Clear the snapshot store entry.
  //
  // Selection is read from the store HERE (not threaded as a mount-captured
  // prop) so it is consumed exactly once. A later remount via TiptapEditor's
  // composite key re-fires `'create'`, but the store entry is already
  // cleared — `peekRenameSnapshot` returns null and the now-stale caret is
  // NOT re-applied over wherever the user has since moved. Step 1 runs
  // before step 2 inside this single handler, so the ordering is explicit
  // (no cross-effect `'create'`-listener registration-order dependency).
  //
  // `fired` makes it one-shot per mount (React Compiler-friendly — the
  // closure is per-effect, no useRef needed). The `getEditorView` check
  // mirrors the canonical pre-mount/post-mount attach pattern above.
  useEffect(() => {
    let fired = false;
    const consume = () => {
      if (fired || editor.isDestroyed) return;
      if (!getEditorView(editor)) return;
      fired = true;
      const selection = peekRenameSnapshot(docName)?.selection ?? null;
      if (selection) {
        try {
          const docSize = editor.state.doc.content.size;
          if (selection.type === 'text') {
            const anchor = Math.max(0, Math.min(selection.anchor, docSize));
            const head = Math.max(0, Math.min(selection.head, docSize));
            editor.commands.setTextSelection({ from: anchor, to: head });
          } else {
            const from = Math.max(0, Math.min(selection.from, docSize));
            editor.commands.setNodeSelection(from);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Structured `console.warn` event — kebab-case (matches
          // `ok-client-persistence-clear-blocked`, `ok-auth-failed-unknown-reason`).
          // Slash-style (`ok/...`) is reserved for `mark()` performance marks;
          // mixing formats breaks downstream `grep`-based log aggregation.
          console.warn(
            JSON.stringify({ event: 'ok-editor-selection-restore-failed', docName, message }),
          );
          // Also emit a perf mark so a restore-side failure surfaces in the
          // Performance timeline alongside the capture-side marks
          // (`ok/cache/snapshot-*-failed`). Capture and restore are the same
          // user-visible failure mode — cursor lost across rename — so they
          // belong on one debugging surface, not split Console/timeline.
          mark('ok/editor/selection-restore-failed', { docName, message });
        }
      }
      // Release the store entry — one-shot consume. Idempotent; a missed
      // snapshot (no rename, or already consumed) is a cheap no-op.
      clearRenameSnapshot(docName);
    };
    if (getEditorView(editor)) {
      consume();
      return undefined;
    }
    editor.on('create', consume);
    return () => {
      editor.off('create', consume);
    };
  }, [editor, docName]);

  // Note: `window.__activeEditor` is exposed centrally from DocumentContext
  // via `Object.defineProperty({get})` reading the `active-editor.ts`
  // registry — populated by the `registerEditor`/`unregisterEditor` effect
  // above. Direct assignment here used to collide with that getter-only
  // accessor and throw "Cannot set property __activeEditor of #<Window>
  // which has only a getter" on any doc open in DEV.

  // Watch activity map and trigger flash. Tracks latest agent activity entry
  // to determine position (append vs prepend) and emits observable state.
  //
  // Observability layers (use whichever is ergonomic for your test):
  //   1. `data-agent-flash-state` attribute on the wrapper (Radix pattern)
  //   2. `window.__agentFlashState` object (poll-based)
  //   3. `document` events: 'agent-flash' (start) and 'agent-flash-end' (complete)
  useEffect(() => {
    const activityMap = provider.document.getMap('agent-flash');
    let lastSeenTimestamp = Date.now();
    let lastFlashTime = 0;
    let pendingTimeout: number | null = null;
    let flashEndTimeout: number | null = null;
    let flashSettledTimeout: number | null = null;

    /** Extract the latest activity entry to know what the agent just wrote */
    const getLatestActivity = (): {
      agentId: string;
      type: string;
      description?: string;
    } | null => {
      let latest: {
        agentId: string;
        type: string;
        description?: string;
        timestamp: number;
      } | null = null;
      for (const [, value] of activityMap.entries()) {
        const entry = value as {
          agentId?: string;
          timestamp?: number;
          type?: string;
          description?: string;
        };
        if (entry.timestamp && (!latest || entry.timestamp > latest.timestamp)) {
          latest = {
            agentId: entry.agentId ?? 'unknown',
            timestamp: entry.timestamp,
            type: entry.type ?? 'insert',
            description: entry.description,
          };
        }
      }
      return latest;
    };

    /** Imperative DOM update — bypasses React re-render to avoid disrupting typing. */
    const applyFlashStateToDom = (state: AgentFlashState) => {
      // `flashStateRef` is the authoritative source in production — the
      // count-monotonicity logic in `triggerFlash` below derives the next
      // count from `flashStateRef.current?.count ?? 0`, not from the
      // window hook. The `window.__agentFlashState` write is a DEV-only
      // test observation channel (per precedent #20); Vite
      // statically replaces `import.meta.env.DEV` at build time so the
      // branch tree-shakes out of production bundles.
      flashStateRef.current = state;
      if (import.meta.env.DEV) {
        window.__agentFlashState = state;
      }
      const el = wrapperRef.current;
      if (el) {
        el.setAttribute('data-agent-flash-state', state.state);
        el.setAttribute('data-agent-flash-count', String(state.count));
        el.setAttribute('data-agent-flash-position', state.position);
        el.setAttribute('data-agent-flash-agent-id', state.lastAgentId ?? '');
      }
    };

    const triggerFlash = () => {
      const latest = getLatestActivity();
      const position: 'append' | 'prepend' = latest?.description?.toLowerCase().includes('prepend')
        ? 'prepend'
        : 'append';

      const nextState: AgentFlashState = {
        state: 'editing',
        // Read from the ref (prod-safe) rather than `window.__agentFlashState`
        // — the window write is DEV-gated and the ref is the authoritative
        // source in production. Keeps count monotonic under rapid re-trigger
        // regardless of whether tests are observing.
        count: (flashStateRef.current?.count ?? 0) + 1,
        lastFiredAt: Date.now(),
        position,
        lastAgentId: latest?.agentId ?? null,
      };

      applyFlashStateToDom(nextState);
      document.dispatchEvent(new CustomEvent('agent-flash', { detail: nextState }));

      // Clear any prior end timers (in case of rapid re-trigger)
      if (flashEndTimeout) clearTimeout(flashEndTimeout);
      if (flashSettledTimeout) clearTimeout(flashSettledTimeout);

      // Transition editing → settled after animation completes
      flashEndTimeout = window.setTimeout(() => {
        const settledState: AgentFlashState = { ...nextState, state: 'settled' };
        applyFlashStateToDom(settledState);
        document.dispatchEvent(new CustomEvent('agent-flash-end', { detail: settledState }));

        // Return to idle after a brief settled window (lets tests observe the transition)
        flashSettledTimeout = window.setTimeout(() => {
          applyFlashStateToDom({ ...settledState, state: 'idle' });
        }, 300);
      }, FLASH_DURATION_MS);
    };

    // Initialize DOM + window state to idle
    applyFlashStateToDom(INITIAL_FLASH_STATE);

    const observer = () => {
      evictStaleEntries(activityMap);

      if (!hasNewEntries(activityMap, lastSeenTimestamp)) return;

      // Skip flash while tab is hidden — the visibility handler will fire a
      // "missed while away" flash when the user returns. Don't advance
      // lastSeenTimestamp here so the refocus check still detects the new
      // entries.
      if (document.visibilityState !== 'visible') return;

      const now = Date.now();
      lastSeenTimestamp = now;

      // Debounce — rapid writes collapse into at most one queued flash
      if (now - lastFlashTime < FLASH_DEBOUNCE_MS) {
        if (!pendingTimeout) {
          const delay = FLASH_DEBOUNCE_MS - (now - lastFlashTime);
          pendingTimeout = window.setTimeout(() => {
            pendingTimeout = null;
            lastFlashTime = Date.now();
            triggerFlash();
          }, delay);
        }
        return;
      }

      lastFlashTime = now;
      triggerFlash();
    };

    activityMap.observe(observer);

    // Visibility change handler: flash on tab refocus for missed writes
    const visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        if (hasNewEntries(activityMap, lastSeenTimestamp)) {
          lastSeenTimestamp = Date.now();
          lastFlashTime = Date.now();
          triggerFlash();
        }
      } else {
        lastSeenTimestamp = Date.now();
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);

    return () => {
      activityMap.unobserve(observer);
      document.removeEventListener('visibilitychange', visibilityHandler);
      if (pendingTimeout) clearTimeout(pendingTimeout);
      if (flashEndTimeout) clearTimeout(flashEndTimeout);
      if (flashSettledTimeout) clearTimeout(flashSettledTimeout);
    };
  }, [provider.document, flashStateRef, wrapperRef]);

  // Scroll to an anchor target after navigating from a wiki link, Mirror
  // "Open source" chrome link, or other `#/<doc>#<slug>` deep-link.
  // Fires on initial editor mount AND on every `hashchange` — the latter
  // covers intra-session navigation where `EditorActivityPool` keeps the
  // target editor pre-mounted (so re-running on `[provider]` alone misses
  // the case where the user clicks a deep-link to a doc already in the
  // pool — provider doesn't change, but the hash anchor does).
  useEffect(() => {
    let attempts = 0;
    let timeoutId: number | undefined;
    let pendingAnchor: string | null = null;
    let pendingHash: string | null = null;
    let handledHash: string | null = null;

    function retryOrGiveUp() {
      if (attempts < ANCHOR_SCROLL_MAX_ATTEMPTS) {
        attempts += 1;
        timeoutId = window.setTimeout(tryScroll, ANCHOR_SCROLL_RETRY_MS);
        return;
      }
      pendingAnchor = null;
      pendingHash = null;
      attempts = 0;
    }

    function findAnchorTarget(anchor: string): HTMLElement | null {
      const realView = getEditorView(editor);
      if (!realView) return null;
      const escapedAnchor = CSS.escape(anchor);
      return (
        realView.dom.querySelector<HTMLElement>(`#${escapedAnchor}`) ??
        realView.dom.querySelector<HTMLElement>(`[data-mirror-source-id="${escapedAnchor}"]`)
      );
    }

    function scrollAnchorIntoView(anchor: string): boolean {
      const el = findAnchorTarget(anchor);
      if (!el) return false;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    }

    // Cold deep links can hit while Activity/ProseMirror layout is still
    // settling; a few follow-up scrolls keep the intended anchor from being
    // undone by late content inflation or scroll restoration.
    function scheduleFollowUpScroll(anchor: string, hash: string) {
      let remaining = ANCHOR_SCROLL_FOLLOW_UP_ATTEMPTS;
      const followUp = () => {
        timeoutId = undefined;
        if (docName !== activeDocName || window.location.hash !== hash) return;
        scrollAnchorIntoView(anchor);
        remaining -= 1;
        if (remaining > 0) {
          timeoutId = window.setTimeout(followUp, ANCHOR_SCROLL_FOLLOW_UP_MS);
        }
      };
      timeoutId = window.setTimeout(followUp, ANCHOR_SCROLL_FOLLOW_UP_MS);
    }

    function tryScroll() {
      if (!pendingAnchor) return;
      if (docName !== activeDocName) return;
      // Heading anchors (HeadingAnchors plugin) set `id={slug}` so
      // `#${slug}` is the primary lookup. MirrorSource blocks
      // intentionally avoid the DOM-id namespace to dodge a slug-vs-id
      // collision with same-named headings — the structural attribute
      // `data-mirror-source-id` is the fallback target. CSS.escape
      // guards against author ids that contain `"`, `\`, etc.
      const anchor = pendingAnchor;
      const hash = pendingHash;
      if (!hash) {
        retryOrGiveUp();
        return;
      }
      if (scrollAnchorIntoView(anchor)) {
        handledHash = hash;
        pendingAnchor = null;
        pendingHash = null;
        attempts = 0;
        scheduleFollowUpScroll(anchor, hash);
      } else {
        retryOrGiveUp();
      }
    }

    function scheduleScrollFromHash() {
      if (docName !== activeDocName) return;
      const hash = window.location.hash;
      if (!pendingAnchor && handledHash === hash) return;
      const anchor = anchorFromHash(hash);
      if (!anchor) {
        handledHash = hash;
        return;
      }
      pendingAnchor = anchor;
      pendingHash = hash;
      attempts = 0;
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      tryScroll();
    }

    function retryPendingOrSchedule() {
      if (docName !== activeDocName) return;
      if (pendingAnchor) {
        tryScroll();
        return;
      }
      scheduleScrollFromHash();
    }

    // Initial mount — handle hash present at mount time.
    scheduleScrollFromHash();
    // Provider sync — handle hash present but doc still loading.
    provider.on('synced', retryPendingOrSchedule);
    // Yjs content can arrive after the initial hash read. Re-check on editor
    // transactions so direct deep links into cold or large docs don't miss the
    // first moment the target heading decoration exists.
    editor.on('transaction', retryPendingOrSchedule);
    // Intra-session navigation — handle hash changes while the editor
    // (and possibly its pool-cached target) stays mounted.
    window.addEventListener('hashchange', scheduleScrollFromHash);

    return () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      provider.off('synced', retryPendingOrSchedule);
      editor.off('transaction', retryPendingOrSchedule);
      window.removeEventListener('hashchange', scheduleScrollFromHash);
    };
  }, [provider, editor, docName, activeDocName]);

  // Outline panel click → scroll the Nth heading in the WYSIWYG DOM into view.
  // Using index (not slug) keeps this robust to duplicate heading texts without
  // re-implementing HeadingAnchors' dedup logic on the outline side.
  useEffect(() => {
    function onNav(e: Event) {
      const detail = (e as CustomEvent<OutlineNavDetail>).detail;
      if (!detail || detail.mode !== 'wysiwyg' || editor.isDestroyed) return;
      // `getEditorView` is the non-throwing accessor for the underlying
      // ProseMirror EditorView (see utils/get-editor-view.ts). Returns
      // undefined pre-mount, never throws on the recycle/remount race.
      const realView = getEditorView(editor);
      if (!realView) return;
      const headings = realView.dom.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6');
      const target = headings[detail.index];
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    window.addEventListener(OUTLINE_NAV_EVENT, onNav);
    return () => window.removeEventListener(OUTLINE_NAV_EVENT, onNav);
  }, [editor]);

  // Publish (or clear) this tab's awareness for the doc this editor binds to.
  //
  // EditorActivityPool keeps multiple TiptapEditor instances mounted in
  // parallel (one per pool entry) — but only ONE of those docs is the
  // foreground at a time. Without the `docName !== activeDocName` gate the
  // effect would fire on mount and then never clear, leaving stale "this user
  // is here" entries on every doc that ever passed through the pool. Peers
  // would dedupe two ghost tabs into a `· N tabs` tooltip even after the
  // user navigated away (they're still pool-cached, WebSocket open, awareness
  // set).
  //
  // `activeDocName` is in the dep list so this re-runs on every navigation:
  // the editor whose doc just became active publishes; the editor whose doc
  // just became inactive calls `setLocalState(null)`, which deletes the entry
  // entirely from y-protocols' awareness map (not just empties it). The
  // delete fans out to peers as an "awareness removal" the same way an
  // ungraceful disconnect would — so peers' usePresence drops the entry
  // immediately, no TTL wait. `buildAwarenessUser` is the pure helper holding
  // the three-state design (unit-tested in awareness-user.test.ts).
  useEffect(() => {
    const awareness = provider.awareness;
    if (!awareness) return;
    if (docName !== activeDocName) {
      awareness.setLocalState(null);
      return;
    }
    // Atomic publish via setLocalState (not two setLocalStateField calls):
    // y-protocols' setLocalStateField short-circuits when localState is null,
    // so once setLocalState(null) ran on a previous navigate-away, a follow-up
    // setLocalStateField('user', ...) would silently no-op. setLocalState
    // unconditionally rebuilds the entry, restoring the navigate-away → back
    // path. Atomicity also means peers never observe an entry with `mode` but
    // no `user` (the discriminator that usePresence filters on).
    //
    // TiptapEditor is the sole writer of `user` and `mode` on per-doc
    // awareness. Two writers (TiptapEditor + SourceEditor's previous
    // setLocalStateField calls) would race on every render — peers' observed
    // mode depended on React's effect-firing order across siblings. Single
    // writer eliminates the race.
    awareness.setLocalState({
      user: buildAwarenessUser({ principal, identity }),
      mode: isSourceMode ? 'source' : 'wysiwyg',
    });
  }, [provider, docName, activeDocName, identity, principal, isSourceMode]);

  // Plumb the React `isSourceMode` prop through to the per-editor WeakMap in
  // `editor-mode-context.ts` — read by the slash / wiki-link / tag Suggestion
  // plugins' `allow` predicates inside @tiptap/suggestion's apply() reducer.
  // The editor stays mounted in source mode (precedent #18(b) hybrid render
  // tree); bridge-propagated transactions would otherwise activate the
  // Suggestion plugins identically to real keystrokes and pop popups into
  // document.body, outside the `.ok-mode-hidden` wrapper.
  useEffect(() => {
    setEditorSourceMode(editor, isSourceMode);
    return () => {
      setEditorSourceMode(editor, false);
    };
  }, [editor, isSourceMode]);

  // Data attributes are set once on initial render; the flash useEffect updates them
  // imperatively via wrapperRef to avoid triggering React re-renders during typing.
  return (
    <div
      ref={wrapperRef}
      className="tiptap-editor h-full"
      data-agent-flash-state="idle"
      data-agent-flash-count="0"
      data-agent-flash-position="append"
      data-agent-flash-agent-id=""
    >
      {/* Both menus portal to document.body, so they escape the
          `ok-mode-hidden` wrapper — the React conditional below is the
          only gate. Slash, wiki-link, and tag suggestion popups are
          gated separately via the `getEditorSourceMode` signal in
          `editor-mode-context.ts`, consumed by each plugin's `allow`
          predicate; unmounting these React menus does NOT affect those
          plugins. */}
      {!isSourceMode && (
        <BubbleMenuBar editor={editor} shortcutEnabled={docName === activeDocName} />
      )}
      {!isSourceMode && <TableCellHandles editor={editor} />}
      {/* Drag handle + "+" chrome is registered as the imperative
          `BlockDragHandle` TipTap extension in `sharedExtensions` —
          bare DOM container, no React involvement. A React-wrapper
          variant (`@tiptap/extension-drag-handle-react`) is
          incompatible with `<Activity>` because the plugin externally
          moves its ref'd `<div>` into `editor.view.dom.parentElement`
          and Activity mode flips then throw `Failed to execute
          'removeChild' on 'Node'` — regression validated against
          docs-open. */}
      {/*
       * Portal slot — JSX-rendered placeholder where the per-Activity
       * portal target is imperatively appended. The actual `<EditorContent>` renders into the portal
       * target via `createPortal` below, but the DOM appears here in
       * the `.tiptap-editor` grid — matching the pre-fix position so
       * scroll geometry (specifically `docs-open.e2e.ts` F1 warm-nav
       * scroll restoration) is unchanged.
       *
       * Structural cross-doc-bleed fix: `<EditorContent>` renders into
       * the per-Activity portal target via `createPortal`, making
       * `editor.view.dom.parentNode` structurally private to THIS editor.
       * Other DOM children of this wrapper (`BubbleMenuBar`,
       * `TableCellHandles`, `SelectionAnnouncer`, `InteractionLayerView`)
       * deliberately stay OUTSIDE the portal — they are not editor-view
       * DOM and don't participate in the
       * `appendChild(...parentNode.childNodes)` vacuum that the upstream
       * `PureEditorContent` lifecycle performs on `view.dom.parentNode`.
       */}
      <div ref={portalSlotRef} style={{ display: 'contents' }} />
      {createPortal(
        // `.tiptap-editor-portal-content` makes this refDiv the effective
        // grid item of `.tiptap-editor` (the `display: contents` chain on
        // `portalSlot` + `portalTarget` makes the refDiv act as a grid
        // item, but `.tiptap-editor > *` only selects DOM direct children
        // — so explicit class-based `grid-column: content` is required).
        // See the rule in `globals.css`.
        // biome-ignore lint/plugin/no-unportaled-editor-content: canonical portaled site — H6 fix per PRECEDENTS.md #44
        <EditorContent
          key={editorContentRevision}
          editor={editor}
          className="tiptap-editor-portal-content h-full"
        />,
        portalTarget,
      )}
      {/* Aria-live announcer for selection changes. Always in the DOM
          (role=status + sr-only) and updates imperatively. */}
      <SelectionAnnouncer editor={editor} />
      {/*
       * <InteractionLayerView> renders the singleton PropPanel / Toolbar /
       * Breadcrumb subtree FOR THE ACTIVE chip — inside the main React tree
       * so PropPanel renderers (InternalLinkPropPanel, WikiLinkPropPanel)
       * inherit context providers like <PageListProvider> + <ThemeProvider>.
       * The layer host (per-editor WeakMap) provides the store; the View
       * subscribes via useState + subscribe and renders the active
       * registration's controls. RawMdxFallback is handled inline
       * via `RawMdxFallbackCMView` (per precedent #30 "all user content
       * visible and editable") and does not register with InteractionLayer.
       *
       * Rendered AFTER EditorContent so its absolute-positioned PropPanels
       * stack above editor content (z-index handled in CSS).
       */}
      <InteractionLayerView store={getInteractionLayer(editor).store} />
    </div>
  );
};

// Expose flash state type on window for test access.
// `__activeEditor` is declared globally in env.d.ts (DocumentContext owns the
// accessor); no duplicate Window augmentation here.
declare global {
  interface Window {
    __agentFlashState?: AgentFlashState;
  }
}
