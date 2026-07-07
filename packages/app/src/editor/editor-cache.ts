/**
 * V2 editor cache — module-level `Map<docName, Entry>` that survives React
 * unmount, SPA navigation, Activity mode flips, StrictMode double-invoke, HMR.
 *
 * Contract (precedent #27(a)):
 *
 *   mount{Tiptap,Cm}Editor({ docName, container, factory })
 *     — CACHE HIT: reparent editor.editorView.dom / view.dom into `container`,
 *       restore scrollTop + focus, set activeMountKey = docName.
 *     — CACHE MISS: factory(container) constructs a fresh editor that mounts
 *       itself into container; the returned tuple is cached.
 *     — CACHE_ENABLED=false: always calls factory, never caches (pre-V2 path).
 *
 *   park{Tiptap,Cm}Editor(entry)
 *     — detach DOM from parent, capture scrollTop, clear activeMountKey.
 *       NEVER destroys. Editor keeps running — local Y.js observers still
 *       fire, plugin state survives, only DOM painting stops.
 *     — CACHE_ENABLED=false: destroys (restores pre-V2 destroy-on-unmount
 *       semantic — the consumer's cleanup path still runs).
 *
 *   evict{Tiptap,Cm}Editor(docName)
 *     — THE ONLY PATH that calls provider.destroy() / ydoc.destroy().
 *       editor.destroy() / view.destroy() are also called on the
 *       __uncached / kill-switch park branch (see park{Tiptap,Cm}Editor).
 *       Called on LRU eviction (MAX_CACHE) or explicit tear-down.
 *
 * Why raw `editor.editorView.dom` reparent and NOT `Editor.mount()/unmount()`:
 *   @tiptap/extension-drag-handle@4.x captures the `editor` ref in a plugin
 *   closure, reads `editor.view.dom.parentElement` from the `view(view)`
 *   lifecycle callback, and hits TipTap's throwing-proxy during the
 *   re-create path (the proxy throws while the new `EditorView` is
 *   mid-construction). STOP rule: this module MUST NOT call `editor.mount()`
 *   or `editor.unmount()`.
 *
 * Why CM6 uses the symmetric pattern: `EditorView.setRoot()` is only needed
 *   for cross-Document reparent (iframe/ShadowRoot); within-Document reparent
 *   needs no API call at all — W3C DOM observers (Mutation / Resize /
 *   Intersection) survive reparent by spec.
 *
 * Emergency kill switch: flip `CACHE_ENABLED = false`,
 *   redeploy. mount() short-circuits to factory-only (no storage); park()
 *   destroys immediately. This is NOT a feature flag — no config system, no
 *   rollout percentage, no user targeting. One-line edit for fire-drill
 *   rollback during a production incident.
 */

import type { Compartment } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { RenamedDocMapping } from '@inkeep/open-knowledge-core';
import type { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';
import { mark } from '@/lib/perf';
import { readNumericOverride } from '@/lib/perf/env-override';
import { getMountId } from './mount-id-registry';
// Cyclic import is intentional and ESM-safe: this module's `mountTiptapEditor`
// is consumed by `mount-promise.ts` (the Suspense + use(promise) primitive),
// and our park / evict spines call back into `mount-promise.ts` to cancel any
// in-flight construction. Both directions only execute inside function bodies
// — no module-init access — so binding resolution is deferred and the cycle
// resolves cleanly. The single tear-down primitive `invalidateMountPromise`
// is the only path that mutates mount-promise cache state from outside its
// module — keep it that way to preserve coordinated lifecycle between this
// V2 cache and the mount-promise cache.
import { invalidateMountPromise } from './mount-promise';

/**
 * Read the per-editor Yjs UndoManager so the caller can null its `restore`
 * field after `editor.destroy()`. Without this, mount/destroy cycles leak the
 * full editor graph (~30 MB per cycle on multi-MB docs) via two cooperating
 * upstream behaviors:
 *
 *  1. Yjs's `UndoManager` constructor registers
 *     `doc.on('destroy', () => this.destroy())` with no stable reference, so
 *     `UndoManager.destroy()` cannot off it. The Set entry retains the
 *     UndoManager forever (verified on yjs@13.6.30, v14.0.0-rc.13, and main —
 *     no upstream fix).
 *  2. `@tiptap/extension-collaboration`'s plugin-view destroy assigns
 *     `undoManager.restore = closure(viewRet, view, editor, binding, ...)` —
 *     the closure captures the entire EditorView + ProsemirrorBinding +
 *     Editor + PM document tree.
 *
 * Clearing `restore` post-destroy breaks the closure chain so the captured
 * graph is GC-eligible. The leaked UndoManager itself remains in
 * `Y.Doc._observers.get('destroy')` but its retained payload drops from
 * ~30 MB to a few hundred bytes per cycle.
 */
export function readEditorUndoManager(editor: Editor): { restore?: unknown } | null {
  try {
    const state = editor.state;
    const pluginState = yUndoPluginKey.getState(state) as
      | { undoManager?: { restore?: unknown } }
      | null
      | undefined;
    return pluginState?.undoManager ?? null;
  } catch (err) {
    // editor.state is a throwing proxy in known TipTap mid-teardown windows.
    // Emit a telemetry mark so a TipTap upgrade that changes the throwing
    // surface (and silently skips the ~30 MB leak-prevention cleanup) is
    // observable in traces — mirrors `ok/cache/evict-failed` discipline.
    mark('ok/cache/undo-manager-read-failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Emergency kill switch. When `false`:
 *   - mount() does NOT cache; always calls factory()
 *   - park() destroys immediately (pre-V2 destroy-on-unmount behavior)
 *   - evict() remains safe but has fewer entries to evict
 *
 * NOT a feature flag. Flipping this is a 1-line
 * code edit + normal deploy. Reserved for production incident response.
 */
export const CACHE_ENABLED = true;

/**
 * Maximum number of cached editor instances per kind (TipTap / CM6),
 * enforced via LRU eviction. Coupled to ACTIVITY_MOUNT_LIMIT=3
 * (EditorActivityPool) + MAX_POOL=10 (ProviderPool); change all three
 * together to keep the throttle, cache, and provider budgets aligned.
 *
 * Test-time override via `window.__okPerfOverrides.MAX_CACHE` or
 * `VITE_OK_PERF_MAX_CACHE` env var (DEV only; see `env-override.ts`).
 */
export const MAX_CACHE = readNumericOverride('MAX_CACHE', 10);

/**
 * Primary cache-admission gate: view-count threshold above which a doc
 * refuses to cache. ~2 ms / view marginal cost × 50 views ≈ 100 ms CPW
 * delta — comfortably within the "Acceptable" band. Keeps cache savings
 * targeted at docs where the editor can actually be cached cheaply;
 * multi-hundred-view docs fall through to pre-V2 destroy-on-unmount
 * behavior (no cache bloat).
 *
 * Test-time override: `VITE_OK_PERF_VIEW_COUNT_CACHE_THRESHOLD` /
 * `window.__okPerfOverrides.VIEW_COUNT_CACHE_THRESHOLD`.
 */
export const VIEW_COUNT_CACHE_THRESHOLD = readNumericOverride('VIEW_COUNT_CACHE_THRESHOLD', 50);

/**
 * Secondary cache-admission gate: byte-count threshold above which a doc
 * refuses to cache. Sized so the largest realistic team docs (~3 MB,
 * ~768 chip views) get admitted with ~2.4× headroom; worst-case cache
 * memory is bounded at MAX_CACHE × this value (~80 MB at 10 × 8 MB).
 *
 * Why this cap matters: cache admission triggers a DOM reparent of the
 * cached editor's subtree (~tens of thousands of nodes for prose-heavy
 * docs) into the visible document. Without block-chunked CV:auto, that
 * reparent forces a single atomic browser-layout pass costing ~14 s for
 * 39K-node subtrees — which is why an 8 MB cap requires CV:auto to be
 * in place. Per-block CV:auto (see `chunk-wrapper-decoration.ts`)
 * collapses that cost to ~3 ms by skipping off-viewport blocks during
 * layout, which is the prerequisite that lets this cap admit multi-MB
 * docs safely.
 *
 * Test-time override: `VITE_OK_PERF_BYTES_CACHE_THRESHOLD` /
 * `window.__okPerfOverrides.BYTES_CACHE_THRESHOLD`.
 */
export const BYTES_CACHE_THRESHOLD = readNumericOverride('BYTES_CACHE_THRESHOLD', 8_000_000);

/** Per-doc size stats captured at mount time to decide whether to cache. */
interface SizeStats {
  /** Count of React MarkView/NodeView targets in the editor at parse time. */
  viewCount: number;
  /** Y.Text byte-length at mount time (used as a proxy for on-disk size). */
  bytes: number;
}

/**
 * Cache-admission gate: evaluated ONCE at mount time. Entry is tagged
 * `__uncached` when this returns false, so all later park/evict/LRU
 * transitions correctly skip caching operations for the entry.
 *
 * Post-mount size changes (user edits push viewCount past 50) do NOT
 * evict an already-cached entry. Eviction is purely LRU-driven.
 *
 * The viewCount branch fires only when `viewCount > 0`. Call sites that
 * have NOT implemented the pre-mount view-count heuristic pass
 * `viewCount: 0` to signal "not measured"; this encoding is preferable to
 * flipping the comparison because it keeps `VIEW_COUNT_CACHE_THRESHOLD = 50`
 * honest as the REAL threshold rather than a latent "0 passes" artifact.
 * Once a caller wires a real heuristic, it passes its estimate unchanged
 * and the gate activates without any threshold edit.
 */
export function shouldCacheEditor(stats: SizeStats): boolean {
  if (stats.viewCount > 0 && stats.viewCount >= VIEW_COUNT_CACHE_THRESHOLD) return false;
  if (stats.bytes > BYTES_CACHE_THRESHOLD) return false;
  return true;
}

/** TipTap editor cache entry. */
export interface TiptapCacheEntry {
  editor: Editor;
  ydoc: Y.Doc;
  ytext: Y.Text;
  provider: HocuspocusProvider;
  /**
   * Container-level `scrollTop` captured at park time, restored at mount
   * time. Preserves the user's reading position across Activity mode flips.
   */
  scrollTop: number;
  /**
   * Whether the editor owned focus at park time. Restored at mount-time
   * only when true — prevents focus hijacking for keyboard users Tab-
   * navigating through the sidebar and for deep-link cold loads where
   * focus was elsewhere (sidebar / header / etc.).
   */
  hadFocus: boolean;
  /**
   * The docName whose mount is currently displaying this editor. Null when
   * parked. Consumers reading editor state from non-render contexts (async
   * callbacks, extension handlers) MUST guard on
   * `entry.activeMountKey === currentDocName` (editor outlives React
   * subtree under V2).
   */
  activeMountKey: string | null;
  /**
   * Per-editor parking DOM node. Lazily created on first park; used as the
   * exclusive detached parent for THIS editor's `view.dom` while parked.
   * Stays attached to the entry for its lifetime — GC'd with the entry on
   * eviction. Per-editor (not shared) so the cross-doc DOM bleed family
   * cannot fire: `@tiptap/react`'s `PureEditorContent.componentDidMount.init()`
   * runs `element.append(...editor.view.dom.parentNode.childNodes)` — if the
   * parking node were shared across editors, that vacuum would drag every
   * parked view.dom into the active editor's wrapper. With one node per
   * entry, `view.dom.parentNode.childNodes` contains only THIS editor's
   * nodes at every lifecycle moment.
   */
  parkingNode: HTMLElement | null;
  /**
   * Set when CACHE_ENABLED=false at mount time. park() destroys this entry
   * instead of parking. Production flips it back to absent by flipping
   * CACHE_ENABLED back to true at module top.
   */
  __uncached?: boolean;
}

/** CodeMirror 6 cache entry. */
export interface CmCacheEntry {
  view: EditorView;
  ydoc: Y.Doc;
  ytext: Y.Text;
  provider: HocuspocusProvider;
  /**
   * The theme `Compartment` embedded in `view` at construction. Stored on the
   * entry — NOT held per React component — because the view is cached and
   * reparented across Activity flips while its consuming `SourceEditor`
   * component remounts (precedent #27(a)). A per-component compartment would
   * not be part of the reused view's config, so a theme-change reconfigure
   * dispatched against it is a silent no-op and the cached view keeps the
   * theme it was built with (stale syntax highlight after a dark/light toggle
   * on backgrounded docs). Consumers reconfigure THIS compartment.
   */
  themeCompartment: Compartment;
  /** Word-wrap compartment embedded in `view`. Same per-entry rationale as
   * `themeCompartment` — a per-component compartment goes stale on reattach
   * after the global word-wrap setting changes while the doc is backgrounded. */
  wordWrapCompartment: Compartment;
  /** Placeholder compartment embedded in `view`. Same per-entry rationale as
   * `themeCompartment` (lowest impact — placeholder only shows on empty docs). */
  placeholderCompartment: Compartment;
  scrollTop: number;
  /** See `TiptapCacheEntry.hadFocus`. */
  hadFocus: boolean;
  activeMountKey: string | null;
  /** See `TiptapCacheEntry.parkingNode`. CM6 doesn't exhibit the same
   * vacuum primitive that `@tiptap/react`'s `PureEditorContent` does, but
   * keeping per-entry parking nodes here too is the symmetric structural
   * choice (one node per cached editor instance) — avoids any future
   * adapter coupling between CM6's detach lifecycle and another tree's
   * lifecycle that could surface a similar bleed. */
  parkingNode: HTMLElement | null;
  __uncached?: boolean;
}

/** Factory result for TipTap — consumer builds the editor bound to container. */
interface TiptapFactoryResult {
  editor: Editor;
  ydoc: Y.Doc;
  ytext: Y.Text;
  provider: HocuspocusProvider;
}

type TiptapFactory = (container: HTMLElement) => TiptapFactoryResult;

/** Factory result for CM6. */
interface CmFactoryResult {
  view: EditorView;
  ydoc: Y.Doc;
  ytext: Y.Text;
  provider: HocuspocusProvider;
  /** Theme compartment embedded in `view`. See `CmCacheEntry.themeCompartment`. */
  themeCompartment: Compartment;
  /** Word-wrap compartment embedded in `view`. See `CmCacheEntry.wordWrapCompartment`. */
  wordWrapCompartment: Compartment;
  /** Placeholder compartment embedded in `view`. See `CmCacheEntry.placeholderCompartment`. */
  placeholderCompartment: Compartment;
}

type CmFactory = (container: HTMLElement) => CmFactoryResult;

interface MountTiptapParams {
  docName: string;
  container: HTMLElement;
  factory: TiptapFactory;
  /**
   * Size stats at mount time. When provided and `shouldCacheEditor` returns
   * false, the returned entry is `__uncached: true` — park() will destroy
   * it rather than stashing it in the cache (pre-V2 fallthrough).
   * When omitted, the editor enters the cache unconditionally (legacy path
   * for callers that don't measure size).
   */
  sizeStats?: SizeStats;
}

interface MountCmParams {
  docName: string;
  container: HTMLElement;
  factory: CmFactory;
  sizeStats?: SizeStats;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const tiptapCache = new Map<string, TiptapCacheEntry>();
const cmCache = new Map<string, CmCacheEntry>();

/**
 * Rename snapshot — captured for `fromDocName` immediately before eviction, keyed
 * under `toDocName` so the new ActivityEntry can consume it on mount. Carries the
 * three pieces of UX state that survive the cold-mount window: the HTML body
 * (painted as `WarmContentFallback` during Suspense), the scrollTop (re-applied
 * to the active scroll container, structurally preserved across the Suspense
 * swap because the container is OUTSIDE the boundary), and the cursor selection
 * (re-applied to the fresh editor's first `'create'` event so the user lands
 * approximately where they left off). Best-effort: any sub-field may be 0 / null
 * on capture failure without dropping the whole snapshot.
 */
export type RenameSelectionJSON =
  | { type: 'text'; anchor: number; head: number }
  | { type: 'node'; from: number };

export interface RenameSnapshot {
  html: string;
  scrollTop: number;
  selection: RenameSelectionJSON | null;
}

const renameSnapshotStore = new Map<string, RenameSnapshot>();

export function storeRenameSnapshot(toDocName: string, snapshot: RenameSnapshot): void {
  if (renameSnapshotStore.size >= MAX_CACHE) {
    const oldest = renameSnapshotStore.keys().next().value;
    if (oldest !== undefined) renameSnapshotStore.delete(oldest);
  }
  renameSnapshotStore.set(toDocName, snapshot);
  mark('ok/cache/snapshot-stored', {
    toDocName,
    htmlBytes: snapshot.html.length,
    hasScroll: snapshot.scrollTop > 0,
    hasSelection: snapshot.selection !== null,
  });
}

/**
 * Read the rename snapshot WITHOUT deleting. StrictMode-safe: the React
 * dev double-invoke of `useState` lazy initializers calls the function
 * twice; consume-and-delete would return the snapshot on call 1 and null
 * on call 2, which clears component state to null mid-double-invoke and
 * flashes the warm fallback empty in dev. peek-then-clear instead lets
 * both invocations return the same value. The matching `clear` runs from
 * TiptapEditor's `editor.on('create')` hook (fires once per editor
 * instance, after StrictMode has settled), not from a useEffect cleanup
 * which would race the second mount's lazy initializer.
 */
export function peekRenameSnapshot(docName: string): RenameSnapshot | null {
  return renameSnapshotStore.get(docName) ?? null;
}

/**
 * Test-only atomic peek-and-delete. Production code MUST NOT use this — the
 * peek + post-mount clear split exists to be StrictMode-safe (see
 * `peekRenameSnapshot` JSDoc). Tests use this single-call form to assert
 * store-level contracts (capture / consume / FIFO eviction) without
 * threading a separate clear through every assertion. Mirrors the
 * `__resetRenameSnapshotStore`, `__getCacheSize`, `__peekCm`, etc. test-only
 * convention.
 */
export function __consumeRenameSnapshot(docName: string): RenameSnapshot | null {
  const snapshot = renameSnapshotStore.get(docName) ?? null;
  renameSnapshotStore.delete(docName);
  mark('ok/cache/snapshot-consumed', {
    docName,
    hit: snapshot !== null,
    hasScroll: snapshot !== null && snapshot.scrollTop > 0,
    hasSelection: snapshot !== null && snapshot.selection !== null,
  });
  return snapshot;
}

/**
 * Release the rename snapshot under `docName`. Idempotent — safe to call
 * twice (StrictMode double-invoke of useEffect cleanup) or from a missed
 * commit path. Emits `ok/cache/snapshot-consumed` here (rather than in
 * peek) so the structured event still fires exactly once per logical
 * consumption, scoped to the post-render commit.
 */
export function clearRenameSnapshot(docName: string): void {
  const hadEntry = renameSnapshotStore.has(docName);
  if (!hadEntry) return;
  const snapshot = renameSnapshotStore.get(docName) ?? null;
  renameSnapshotStore.delete(docName);
  mark('ok/cache/snapshot-consumed', {
    docName,
    hit: snapshot !== null,
    hasScroll: snapshot !== null && snapshot.scrollTop > 0,
    hasSelection: snapshot !== null && snapshot.selection !== null,
  });
}

/** Test-only: clear the rename snapshot store. */
export function __resetRenameSnapshotStore(): void {
  renameSnapshotStore.clear();
}

/**
 * Best-effort live scrollTop read from the active editor scroll container.
 * The active doc's `ScrollPreservingContainer` pins `data-testid="editor-scroll-container"`
 * on its outer scrollable div (`EditorActivityPool.tsx`). Only the active doc's
 * container is rendered at any time (hidden Activity entries don't paint DOM per
 * React 19.2), so the query is unambiguous.
 */
function readActiveScrollTop(): number {
  try {
    if (typeof document === 'undefined') return 0;
    const el = document.querySelector<HTMLDivElement>('[data-testid="editor-scroll-container"]');
    return el?.scrollTop ?? 0;
  } catch (err) {
    // The fallback 0 is indistinguishable from a legitimate "scroll at top";
    // without this mark, a querySelector failure would silently produce a
    // snapshot with scrollTop:0 / hasScroll:false. The outer
    // captureRenameSnapshots catch does NOT cover this path — the helper
    // returns a fallback rather than throwing — so the mark must live here.
    mark('ok/cache/snapshot-scroll-read-failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Best-effort selection capture from a live TipTap editor. Returns a JSON-able
 * shape for TextSelection / NodeSelection — the two common selection types
 * users actually have at rename time. AllSelection / GapCursor / custom types
 * fall through to null (editor will mount with default selection on the new
 * docName).
 */
function captureSelection(editor: Editor): RenameSelectionJSON | null {
  try {
    const sel = editor.state.selection;
    if (sel instanceof TextSelection) {
      return { type: 'text', anchor: sel.anchor, head: sel.head };
    }
    if (sel instanceof NodeSelection) {
      return { type: 'node', from: sel.from };
    }
    return null;
  } catch (err) {
    // Distinct from the legitimate null return (unsupported selection type):
    // this null means `editor.state` access threw. The outer
    // captureRenameSnapshots catch does NOT cover this path — the helper
    // returns a fallback rather than throwing — so the mark must live here.
    mark('ok/cache/snapshot-selection-read-failed', {
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Best-effort warm-skeleton snapshot capture before rename eviction. Captures
 * HTML body, scrollTop of the active scroll container, and the live editor's
 * selection. Each doc is wrapped in its own try/catch so any one capture
 * failure falls back to EditorSkeleton without aborting reconciliation cleanup.
 */
export function captureRenameSnapshots(renamed: readonly RenamedDocMapping[]): void {
  for (const renamedDoc of renamed) {
    try {
      const cachedEntry = peekTiptap(renamedDoc.fromDocName);
      if (cachedEntry && !cachedEntry.editor.isDestroyed) {
        // Never-edited source → Y.Text is empty AND `getHTML()` returns
        // literal `<p></p>` (the `is-empty` placeholder class is a
        // ProseMirror Decoration, not part of HTML output). Rendering that
        // empty HTML as `WarmContentFallback` produces a visually-blank
        // `pointer-events-none` overlay on a freshly-mounted editor.
        // Skipping the snapshot here drops the Suspense fallback back to
        // `<EditorSkeleton />`, which is non-blocking and signals "loading"
        // visibly — exactly the right surface for a create→inline-rename
        // flow where there is no user content to restore. Y.Text is the
        // canonical empty-check (precedent #38: Y.Text-is-truth).
        if (cachedEntry.ytext.length === 0) {
          mark('ok/cache/snapshot-skipped-empty', {
            fromDocName: renamedDoc.fromDocName,
          });
          continue;
        }
        storeRenameSnapshot(renamedDoc.toDocName, {
          html: cachedEntry.editor.getHTML(),
          scrollTop: readActiveScrollTop(),
          selection: captureSelection(cachedEntry.editor),
        });
      } else {
        mark('ok/cache/snapshot-skipped', { fromDocName: renamedDoc.fromDocName });
      }
    } catch (err) {
      // HTML serialization failure — fall back to EditorSkeleton (pre-fix behavior).
      // Mark for observability so a future throwing surface (e.g., TipTap upgrade,
      // mid-teardown editor.getHTML()) is visible in the perf timeline rather than
      // silently degrading to the skeleton. Matches the module-wide pattern at
      // (ok/cache/undo-manager-read-failed), (ok/cache/evict-failed),
      // (ok/cache/park-destroy-failed) — every other catch in this file that
      // suppresses an exception emits a mark with the error message.
      mark('ok/cache/snapshot-capture-failed', {
        fromDocName: renamedDoc.fromDocName,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** LRU order — most-recently-used at the END; oldest at index 0. */
const tiptapLru: string[] = [];
const cmLru: string[] = [];

/**
 * Shared activity-mount list across TipTap + CM caches. Single source of
 * truth for "which cached docs are currently Activity-visible." The
 * consumer (EditorActivityPool) computes the list as the top
 * ACTIVITY_MOUNT_LIMIT MRU entries and calls setActivityMountList on
 * every change.
 *
 * Activity-hidden observer CPU cap:
 *   Cached docs NOT in this list have their HocuspocusProvider
 *   disconnected so peer CRDT updates stop arriving. Local Y.js observers
 *   still fire (Y.Doc-driven), preserving user-local edit UX. When a doc
 *   is re-promoted into the list, we reconnect the provider.
 *
 * Providers are shared between TipTap + CM entries for the same docName
 * (ProviderPool owns the provider; both caches hold refs). So this
 * tracking is keyed by docName, not by entry kind.
 */
let activityMountList: ReadonlySet<string> = new Set();

/**
 * Lazily create a fresh per-entry parking node. Each cached editor gets its
 * own detached DOM parent for park/unpark cycles, so `view.dom.parentNode`
 * is exclusively this editor's at every lifecycle moment — the structural
 * enforcement of TipTap view.dom DOM-tree exclusivity. A previously-shared
 * singleton (`_parkingNode`) had every
 * parked editor's `view.dom` end up as siblings, which `@tiptap/react`'s
 * `PureEditorContent.componentDidMount.init()` vacuum then dragged into
 * the active editor's wrapper on remount — the cross-doc-bleed cause.
 *
 * Each node is reachable only through its `TiptapCacheEntry` / `CmCacheEntry`;
 * eviction drops the entry, the node is GC'd. In test environments without
 * a DOM, returns null — callers fall back to detached-orphan mode
 * (MutationObserver subscriptions survive fully orphan DOM).
 */
function tryCreateParkingNode(): HTMLElement | null {
  if (typeof document === 'undefined') {
    return null;
  }
  const el = document.createElement('div');
  el.setAttribute('data-ok-editor-parking', '');
  el.style.display = 'none';
  el.style.position = 'absolute';
  el.style.left = '-99999px';
  return el;
}

// ---------------------------------------------------------------------------
// TipTap API
// ---------------------------------------------------------------------------

/**
 * Mount the editor for `docName` into `container`. On cache hit, reparents
 * the existing DOM via raw `editor.editorView.dom` reparent. On cache
 * miss, calls `factory(container)` to construct a fresh editor.
 *
 * When CACHE_ENABLED=false: always constructs via factory, never caches.
 * The returned entry carries `__uncached: true` so park() destroys it.
 */
export function mountTiptapEditor(params: MountTiptapParams): TiptapCacheEntry {
  const { docName, container, factory, sizeStats } = params;

  // Size gate + kill-switch — either path returns an __uncached entry so
  // park() destroys it (pre-V2 destroy-on-unmount behavior).
  const gateRefuses = sizeStats ? !shouldCacheEditor(sizeStats) : false;
  if (!CACHE_ENABLED || gateRefuses) {
    const fresh = factory(container);
    mark('ok/cache/miss', {
      docName,
      mountId: getMountId(docName),
      viewCount: sizeStats?.viewCount ?? -1,
      bytes: sizeStats?.bytes ?? -1,
      reason: !CACHE_ENABLED ? 'kill-switch' : 'size-gate',
    });
    return {
      editor: fresh.editor,
      ydoc: fresh.ydoc,
      ytext: fresh.ytext,
      provider: fresh.provider,
      scrollTop: 0,
      hadFocus: false,
      activeMountKey: docName,
      parkingNode: null,
      __uncached: true,
    };
  }

  // Factory-ref binding-identity check was attempted (intent: evict the entry
  // when the caller's factory closure differs from the cached one, signalling
  // a docName reuse with a swapped upstream provider/Y.Doc). Empirically
  // refuted as the user-bleed mechanism AND structurally incompatible with
  // mount-promise's HIT-only throw-factory pattern (the throw-factory's
  // closure identity always differs from any pre-population factory's, so the
  // check spurious-evicts and triggers MISS-path throw-factory invocation →
  // 5s test timeout). Defensive contract preserved as a follow-up — needs
  // either a stable factory-ref convention OR a different signal (Y.Doc
  // identity comparison) that doesn't conflict with the HIT-only pattern.
  const reuse = tiptapCache.get(docName);
  if (reuse) {
    // Bracket the reparent + scroll/focus restore in span marks so the
    // cache-hit latency curve can be measured independently of surrounding
    // navigation work.
    mark('ok/cache/reparent-start', {
      docName,
      mountId: getMountId(docName),
      kind: 'tiptap',
      viewCount: sizeStats?.viewCount ?? -1,
      bytes: sizeStats?.bytes ?? -1,
    });
    reparentTiptapDom(reuse, container);
    reuse.activeMountKey = docName;
    touchLru(tiptapLru, docName);
    // Restore scroll AFTER DOM is re-attached (scrollTop on detached nodes
    // is a no-op in real browsers).
    container.scrollTop = reuse.scrollTop;
    // Focus restore is gated on "had focus at park time". Blindly calling
    // .focus() on every mount hijacks focus from keyboard users
    // Tab-navigating through the sidebar and from deep-link cold loads
    // where focus was elsewhere.
    if (reuse.hadFocus) {
      try {
        reuse.editor.commands.focus();
      } catch {
        // Editor may be mid-transition or destroyed; focus is best-effort.
      }
    }
    mark('ok/cache/reparent-end', {
      docName,
      mountId: getMountId(docName),
      kind: 'tiptap',
      viewCount: sizeStats?.viewCount ?? -1,
      bytes: sizeStats?.bytes ?? -1,
    });
    mark('ok/cache/hit', { docName, mountId: getMountId(docName), kind: 'tiptap' });
    // Telemetry: cache-hit mount emits stats with cacheHit=true.
    if (sizeStats) {
      mark('ok/cold/editor-mount-stats', {
        docName,
        mountId: getMountId(docName),
        viewCount: sizeStats.viewCount,
        bytes: sizeStats.bytes,
        cacheHit: true,
        kind: 'tiptap',
      });
    }
    return reuse;
  }

  // Cache miss — enforce capacity BEFORE inserting the new entry so the
  // new entry never races against its own eviction.
  while (tiptapCache.size >= MAX_CACHE) {
    const oldest = findEvictable(tiptapLru, docName);
    if (!oldest) break;
    evictTiptapEditor(oldest);
  }

  const fresh = factory(container);
  const entry: TiptapCacheEntry = {
    editor: fresh.editor,
    ydoc: fresh.ydoc,
    ytext: fresh.ytext,
    provider: fresh.provider,
    scrollTop: 0,
    hadFocus: false,
    activeMountKey: docName,
    parkingNode: null,
  };
  tiptapCache.set(docName, entry);
  touchLru(tiptapLru, docName);
  mark('ok/cache/miss', {
    docName,
    mountId: getMountId(docName),
    viewCount: sizeStats?.viewCount ?? -1,
    bytes: sizeStats?.bytes ?? -1,
    reason: 'cold',
    kind: 'tiptap',
  });
  if (sizeStats) {
    mark('ok/cold/editor-mount-stats', {
      docName,
      mountId: getMountId(docName),
      viewCount: sizeStats.viewCount,
      bytes: sizeStats.bytes,
      cacheHit: false,
      kind: 'tiptap',
    });
  }
  return entry;
}

/**
 * Park the editor: detach DOM from its current parent, capture scrollTop,
 * clear activeMountKey. Editor instance is preserved in the cache.
 *
 * When CACHE_ENABLED=false (or entry is __uncached): destroys the editor
 * immediately, restoring pre-V2 destroy-on-unmount semantics.
 *
 * Mount-promise cancellation: an in-flight mount-promise body might still
 * be in its construct→yield→mount window when park fires (rapid nav-away
 * from a doc the user just opened). Invalidate FIRST so the body's
 * post-yield abort check fires (`controller.signal.aborted` → destroy
 * pre-mount editor + reject) BEFORE we touch DOM here. Without this:
 *   1. Body finishes mount() after our park, lands a phantom editor in the V2
 *      cache, and the cache holds two entries for the same docName.
 *   2. mount-promise's RESOLVED entry holds a stable reference to this V2
 *      entry; without invalidation a subsequent use() returns the same
 *      resolved promise, skipping the V2 reparent path — the editor's
 *      view.dom would stay stranded in the parking node instead of returning
 *      to the consumer's container on remount.
 * The docName comes from `entry.activeMountKey` (canonical at park-call time;
 * null only if park was already invoked or the entry was constructed
 * outside the mount-promise path). Skipping the call when null avoids a
 * no-op `ok/mount/invalidate` telemetry mark on already-parked entries.
 */
export function parkTiptapEditor(entry: TiptapCacheEntry): void {
  const docName = entry.activeMountKey;
  // Mount-promise cache lifetime tracks V2-cache-entry lifetime, not React-
  // component lifetime. Park preserves the V2 entry (editor stays alive),
  // so the corresponding mount-promise must also stay so that the next
  // mount of this docName returns the SAME promise reference. React's
  // `use()` on a stable `.status='fulfilled'` thenable short-circuits with
  // no Suspense cycle; on a fresh promise it pays a Suspense fallback
  // flash, which surfaces as a "cold load" between Activity-pool tabs.
  // Only invalidate when the V2 entry is destroyed: (a) kill-switch /
  // __uncached fallthrough below, (b) `evictTiptapEditor`. Mid-construction
  // cancellation goes through evict (or the orphaned body completes harmlessly
  // and is GC'd by the next LRU eviction); park is never reachable while the
  // mount-promise body is in flight because the consumer needs the resolved
  // entry from `use()` before its useEffect cleanup can register.
  if (!CACHE_ENABLED || entry.__uncached) {
    if (docName) {
      // Kill-switch / size-gate fallthrough: editor is about to be destroyed,
      // so the mount-promise cache entry would point to a dead editor. Cancel
      // any in-flight body (rare — __uncached bypasses cache so promise is
      // typically already resolved) and remove the entry.
      invalidateMountPromise(docName);
    }
    // Kill-switch / uncached fallthrough: destroy the editor now. Provider
    // + ydoc are NOT destroyed — they're owned by the ProviderPool which
    // has its own eviction logic.
    //
    // Capture the UndoManager BEFORE destroy — `editor.state` is only safely
    // readable while the editor is alive. After destroy, clear
    // `undoManager.restore` to break the @tiptap/extension-collaboration
    // closure that retains the full editor graph. See `readEditorUndoManager`
    // above for the complete chain.
    const undoManager = readEditorUndoManager(entry.editor);
    try {
      entry.editor.destroy();
    } catch (err) {
      // Mirror evictTiptapEditor's discipline: emit a telemetry mark on
      // destroy() failure so a TipTap regression in the kill-switch /
      // __uncached destroy path is observable in traces. Without this,
      // every park-on-unmount under CACHE_ENABLED=false (fire-drill
      // rollback) silently swallows TipTap errors.
      mark('ok/cache/park-destroy-failed', {
        docName: docName ?? '',
        kind: 'tiptap',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (undoManager) {
      undoManager.restore = undefined;
    }
    entry.activeMountKey = null;
    return;
  }

  const view = getTiptapEditorView(entry.editor);
  if (view) {
    // Capture hadFocus BEFORE detaching — once the DOM leaves its parent
    // activeElement drops to <body> and we'd always record false.
    entry.hadFocus = computeHadFocus(view.dom);
    const scrollSrc = view.scrollDOM ?? view.dom.parentElement ?? view.dom;
    entry.scrollTop = (scrollSrc as HTMLElement).scrollTop ?? 0;
    const parent = view.dom.parentElement;
    if (parent) {
      parent.removeChild(view.dom);
    }
    // Attach to PER-ENTRY parking node — exclusive to this editor — so
    // `view.dom.parentNode.childNodes` contains only this editor's nodes at
    // the moment `@tiptap/react`'s `PureEditorContent.componentDidMount.init()`
    // vacuums them. Shared parking would interleave foreign view.doms with
    // this editor's, surfacing the cross-doc-bleed family on warm-mount.
    entry.parkingNode ||= tryCreateParkingNode();
    if (entry.parkingNode) {
      entry.parkingNode.appendChild(view.dom);
    }
  }

  entry.activeMountKey = null;
}

/**
 * Evict the editor for `docName` — destroys provider + ydoc + editor.
 * `editor.destroy()` is also called by `parkTiptapEditor`'s __uncached /
 * kill-switch branch, but provider/ydoc destruction happens only here.
 * Safe no-op if docName is not cached. Returns true if a V2 entry was
 * destroyed, false otherwise.
 *
 * Mount-promise cancellation: invalidate UNCONDITIONALLY before the V2
 * lookup. The during-yield case is the architectural reason: V2 has
 * no entry yet (mount() hasn't run), but mount-promise has an in-flight
 * entry whose body is mid-construct → yield → mount. Without invalidation,
 * the body would proceed past the yield, mount the editor, and land a
 * phantom V2 entry behind the user's "I evicted this doc" intent. The
 * return value reflects only the V2 destroy outcome — mount-promise
 * invalidation is a side effect orthogonal to the V2 cache state.
 *
 * Each sub-destroy is wrapped in try/catch because destroy can throw in
 * known mid-teardown states (e.g. TipTap's throwing proxy). But a
 * genuine memory / socket / Y.Doc leak would manifest as a silent cache
 * bloat with no observable signal. Every catch emits
 * `ok/cache/evict-failed` so a developer profiling V2 in Chrome DevTools
 * Extensibility can see real eviction failures.
 */
export function evictTiptapEditor(docName: string): boolean {
  invalidateMountPromise(docName);
  const entry = tiptapCache.get(docName);
  if (!entry) return false;

  // See parkTiptapEditor / readEditorUndoManager for the rationale on
  // capture-before-destroy + clear-restore-after.
  const undoManager = readEditorUndoManager(entry.editor);
  try {
    entry.editor.destroy();
  } catch (err) {
    mark('ok/cache/evict-failed', {
      docName,
      kind: 'tiptap',
      stage: 'editor',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  if (undoManager) {
    undoManager.restore = undefined;
  }
  try {
    entry.provider.destroy();
  } catch (err) {
    mark('ok/cache/evict-failed', {
      docName,
      kind: 'tiptap',
      stage: 'provider',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    entry.ydoc.destroy();
  } catch (err) {
    mark('ok/cache/evict-failed', {
      docName,
      kind: 'tiptap',
      stage: 'ydoc',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  tiptapCache.delete(docName);
  const lruIdx = tiptapLru.indexOf(docName);
  if (lruIdx !== -1) tiptapLru.splice(lruIdx, 1);
  mark('ok/cache/evict', { docName, kind: 'tiptap' });
  return true;
}

// ---------------------------------------------------------------------------
// CodeMirror 6 API — symmetric to TipTap
// ---------------------------------------------------------------------------

/**
 * Mount the CM6 editor for `docName` into `container`. On cache hit,
 * reparents the existing `view.dom`. On cache miss, calls
 * `factory(container)` to construct a fresh `EditorView`.
 *
 * When CACHE_ENABLED=false: always constructs via factory, never caches.
 *
 * The cached `EditorView` is held outside React's component lifecycle by
 * design: the cache plus per-entry `parkingNode` preserve the live view
 * across React unmount/remount so a warm switch never re-pays the
 * `new EditorView()` construction cost. Do NOT adopt a React-CodeMirror
 * wrapper (`@uiw/react-codemirror` and similar) for the source editor;
 * those own the view lifecycle as a React component and destroy it on
 * unmount, bypassing this cache and reintroducing the per-switch cost.
 * The sanctioned shape is a bare `new EditorView({ parent })` inside
 * `factory`, with the instance owned by this cache.
 */
export function mountCmEditor(params: MountCmParams): CmCacheEntry {
  const { docName, container, factory, sizeStats } = params;

  const gateRefuses = sizeStats ? !shouldCacheEditor(sizeStats) : false;
  if (!CACHE_ENABLED || gateRefuses) {
    const fresh = factory(container);
    mark('ok/cache/miss', {
      docName,
      mountId: getMountId(docName),
      viewCount: sizeStats?.viewCount ?? -1,
      bytes: sizeStats?.bytes ?? -1,
      reason: !CACHE_ENABLED ? 'kill-switch' : 'size-gate',
      kind: 'cm',
    });
    return {
      view: fresh.view,
      ydoc: fresh.ydoc,
      ytext: fresh.ytext,
      provider: fresh.provider,
      themeCompartment: fresh.themeCompartment,
      wordWrapCompartment: fresh.wordWrapCompartment,
      placeholderCompartment: fresh.placeholderCompartment,
      scrollTop: 0,
      hadFocus: false,
      activeMountKey: docName,
      parkingNode: null,
      __uncached: true,
    };
  }

  // See TipTap-site comment for the rationale on omitting the
  // factory-ref binding-identity check at this site as well.

  const reuse = cmCache.get(docName);
  if (reuse) {
    // Symmetric span marks for CM6.
    mark('ok/cache/reparent-start', {
      docName,
      mountId: getMountId(docName),
      kind: 'cm',
      viewCount: sizeStats?.viewCount ?? -1,
      bytes: sizeStats?.bytes ?? -1,
    });
    reparentCmDom(reuse, container);
    reuse.activeMountKey = docName;
    touchLru(cmLru, docName);
    container.scrollTop = reuse.scrollTop;
    if (reuse.hadFocus) {
      try {
        reuse.view.focus();
      } catch {
        // best-effort focus
      }
    }
    mark('ok/cache/reparent-end', {
      docName,
      mountId: getMountId(docName),
      kind: 'cm',
      viewCount: sizeStats?.viewCount ?? -1,
      bytes: sizeStats?.bytes ?? -1,
    });
    mark('ok/cache/hit', { docName, mountId: getMountId(docName), kind: 'cm' });
    if (sizeStats) {
      mark('ok/cold/editor-mount-stats', {
        docName,
        mountId: getMountId(docName),
        viewCount: sizeStats.viewCount,
        bytes: sizeStats.bytes,
        cacheHit: true,
        kind: 'cm',
      });
    }
    return reuse;
  }

  while (cmCache.size >= MAX_CACHE) {
    const oldest = findEvictable(cmLru, docName);
    if (!oldest) break;
    evictCmEditor(oldest);
  }

  const fresh = factory(container);
  const entry: CmCacheEntry = {
    view: fresh.view,
    ydoc: fresh.ydoc,
    ytext: fresh.ytext,
    provider: fresh.provider,
    themeCompartment: fresh.themeCompartment,
    wordWrapCompartment: fresh.wordWrapCompartment,
    placeholderCompartment: fresh.placeholderCompartment,
    scrollTop: 0,
    hadFocus: false,
    activeMountKey: docName,
    parkingNode: null,
  };
  cmCache.set(docName, entry);
  touchLru(cmLru, docName);
  mark('ok/cache/miss', {
    docName,
    mountId: getMountId(docName),
    viewCount: sizeStats?.viewCount ?? -1,
    bytes: sizeStats?.bytes ?? -1,
    reason: 'cold',
    kind: 'cm',
  });
  if (sizeStats) {
    mark('ok/cold/editor-mount-stats', {
      docName,
      mountId: getMountId(docName),
      viewCount: sizeStats.viewCount,
      bytes: sizeStats.bytes,
      cacheHit: false,
      kind: 'cm',
    });
  }
  return entry;
}

/**
 * Park the CM6 editor — detach `view.dom`, save scrollTop, clear
 * activeMountKey. Does NOT call `view.destroy()` in the cached path.
 * When CACHE_ENABLED=false (or entry is __uncached): destroys the view
 * immediately, restoring pre-V2 destroy-on-unmount semantics.
 */
export function parkCmEditor(entry: CmCacheEntry): void {
  if (!CACHE_ENABLED || entry.__uncached) {
    try {
      entry.view.destroy();
    } catch (err) {
      // Mirror evictCmEditor's discipline: emit a telemetry mark on
      // destroy() failure so a CM6 regression in the kill-switch /
      // __uncached destroy path is observable in traces.
      mark('ok/cache/park-destroy-failed', {
        docName: entry.activeMountKey ?? '',
        kind: 'cm',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    entry.activeMountKey = null;
    return;
  }

  const dom = entry.view.dom;
  // Capture hadFocus BEFORE detaching (see TipTap path for rationale).
  entry.hadFocus = computeHadFocus(dom as HTMLElement);
  const scrollSrc = entry.view.scrollDOM ?? dom;
  entry.scrollTop = (scrollSrc as HTMLElement).scrollTop ?? 0;
  const parent = dom.parentElement;
  if (parent) {
    parent.removeChild(dom);
  }
  // Per-entry parking node — see `parkTiptapEditor` for the bleed-prevention
  // rationale. Symmetric with TipTap so the two caches stay structurally aligned.
  entry.parkingNode ||= tryCreateParkingNode();
  if (entry.parkingNode) {
    entry.parkingNode.appendChild(dom);
  }
  entry.activeMountKey = null;
}

/**
 * Evict the CM6 editor — destroys provider + ydoc + view.
 * `view.destroy()` is also called by `parkCmEditor`'s __uncached /
 * kill-switch branch, but provider/ydoc destruction happens only here.
 * Emits `ok/cache/evict-failed` on any sub-destroy throw so real
 * memory/socket/Y.Doc leaks surface in telemetry.
 */
export function evictCmEditor(docName: string): boolean {
  const entry = cmCache.get(docName);
  if (!entry) return false;

  try {
    entry.view.destroy();
  } catch (err) {
    mark('ok/cache/evict-failed', {
      docName,
      kind: 'cm',
      stage: 'view',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    entry.provider.destroy();
  } catch (err) {
    mark('ok/cache/evict-failed', {
      docName,
      kind: 'cm',
      stage: 'provider',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    entry.ydoc.destroy();
  } catch (err) {
    mark('ok/cache/evict-failed', {
      docName,
      kind: 'cm',
      stage: 'ydoc',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  cmCache.delete(docName);
  const lruIdx = cmLru.indexOf(docName);
  if (lruIdx !== -1) cmLru.splice(lruIdx, 1);
  mark('ok/cache/evict', { docName, kind: 'cm' });
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * TipTap exposes `view` as a throwing proxy pre-mount; `editorView` is the
 * non-throwing private ref. Code that reads DOM state from arbitrary
 * contexts (async callbacks, extension lifecycle, Activity flips) MUST go
 * through this accessor — see the WARN rule on TipTap's throwing view proxy.
 */
function getTiptapEditorView(editor: Editor): { dom: HTMLElement; scrollDOM?: HTMLElement } | null {
  const view = (editor as unknown as { editorView?: { dom: HTMLElement; scrollDOM?: HTMLElement } })
    .editorView;
  return view ?? null;
}

/**
 * Whether the given DOM element (or any descendant) holds the document's
 * current active element. Used to gate focus restoration on Activity flip
 * — blind .focus() on every mount hijacks focus from keyboard users +
 * deep-link cold loads where focus was legitimately elsewhere.
 */
function computeHadFocus(root: HTMLElement): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  if (!active) return false;
  if (active === root) return true;
  // `HTMLElement.contains` is DOM-level, read-only, no side effects.
  return root.contains(active);
}

function reparentTiptapDom(entry: TiptapCacheEntry, container: HTMLElement): void {
  const view = getTiptapEditorView(entry.editor);
  if (!view) return;
  const dom = view.dom;
  const prevParent = dom.parentElement;
  if (prevParent && prevParent !== container) {
    prevParent.removeChild(dom);
  }
  if (dom.parentElement !== container) {
    container.appendChild(dom);
  }
}

function reparentCmDom(entry: CmCacheEntry, container: HTMLElement): void {
  const dom = entry.view.dom;
  const prevParent = dom.parentElement;
  if (prevParent && prevParent !== container) {
    prevParent.removeChild(dom);
  }
  if (dom.parentElement !== container) {
    container.appendChild(dom);
  }
}

function touchLru(lru: string[], docName: string): void {
  const idx = lru.indexOf(docName);
  if (idx !== -1) lru.splice(idx, 1);
  lru.push(docName);
}

/**
 * Find the oldest entry in `lru` that is NOT the one being mounted AND
 * NOT currently Activity-mounted. Returns null if no evictable candidate
 * exists (rare in practice — MAX_CACHE=10 with ACTIVITY_MOUNT_LIMIT=3
 * always leaves 7 parkable slots).
 *
 * If every entry is Activity-mounted (edge case: user somehow navigated
 * to more tabs than the limit without setActivityMountList being called),
 * fall back to pure-LRU ordering so capacity enforcement isn't blocked.
 */
function findEvictable(lru: string[], mountingDocName: string): string | null {
  // Prefer NON-active evictees.
  for (const docName of lru) {
    if (docName === mountingDocName) continue;
    if (activityMountList.has(docName)) continue;
    return docName;
  }
  // Degenerate fallback — pure LRU. Should not occur under normal operation
  // (MAX_CACHE=10 vs ACTIVITY_MOUNT_LIMIT=3 means at most 3 entries can be
  // Activity-mounted, leaving 7 non-active candidates). If we reach here,
  // something upstream is out of sync (setActivityMountList not called,
  // mount/list drift, or a callsite bypassing the contract). Surface as
  // telemetry so the anomaly is visible.
  mark('ok/cache/evict-fallback-activity-saturated', {
    mountingDocName,
    lruLength: lru.length,
    activityMountCount: activityMountList.size,
  });
  for (const docName of lru) {
    if (docName === mountingDocName) continue;
    return docName;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Activity-mount list + provider connect/disconnect
// ---------------------------------------------------------------------------

/**
 * Update the activity-mount list. Any cached editor whose docName was in
 * the previous list but is NOT in the new list has its HocuspocusProvider
 * disconnected (peer CRDT updates stop arriving — observer CPU cap).
 * Any docName newly promoted from hidden → active has its provider
 * reconnected.
 *
 * Single-writer API: called by `EditorActivityPool` on every
 * `computeActivityMountList` change.
 *
 * Transitions are keyed by docName because the HocuspocusProvider is
 * shared across the TipTap + CM cache entries for a given doc (owned
 * by ProviderPool). Connect/disconnect fires at most once per doc per
 * transition, regardless of which/how-many cache kinds hold a ref.
 */
export function setActivityMountList(docNames: readonly string[]): void {
  const prev = activityMountList;
  const next = new Set(docNames);

  // Demotion — fired for docs that were active, now aren't. Emits
  // `ok/cache/disconnect` only on success, `ok/cache/disconnect-failed`
  // on provider-destroyed state so the observer-CPU cap signal is honest.
  for (const docName of prev) {
    if (next.has(docName)) continue;
    const provider = findProvider(docName);
    if (!provider) continue;
    try {
      provider.disconnect();
      mark('ok/cache/disconnect', { docName });
    } catch (err) {
      mark('ok/cache/disconnect-failed', {
        docName,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Promotion — fired for docs that are newly active. connect() may
  // return a Promise (Hocuspocus v3+) or undefined (older versions). The
  // success vs failure emission is mutually exclusive: when the returned
  // Promise rejects, only `connect-failed` fires — not `connect` followed
  // by `connect-failed` for the same activation. Consumers filtering by
  // mark kind (observer-CPU cap dashboards) no longer over-count successes.
  for (const docName of next) {
    if (prev.has(docName)) continue;
    const provider = findProvider(docName);
    if (!provider) continue;
    const emitFailed = (err: unknown): void => {
      mark('ok/cache/connect-failed', {
        docName,
        message: err instanceof Error ? err.message : String(err),
      });
    };
    try {
      const result = provider.connect();
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        // Async branch — emit success inside .then so failure is
        // mutually exclusive. The .then+reject form is preferred over
        // .then().catch() because .catch rejections from the success
        // handler would double-count as failures.
        (result as Promise<unknown>).then(
          () => mark('ok/cache/connect', { docName }),
          (err) => emitFailed(err),
        );
      } else {
        // Synchronous return — success is observable immediately.
        mark('ok/cache/connect', { docName });
      }
    } catch (err) {
      emitFailed(err);
    }
  }

  activityMountList = next;
}

/**
 * Provider-pool reference, set on `subscribePoolEviction` and cleared on its
 * unsubscribe. `findProvider` walks `entries` here (not just the V2 cache) so
 * providers for pool-resident-but-not-V2-cached docs still get connect /
 * disconnect transitions on `setActivityMountList` calls. Without this
 * fallback, the demote path silently skipped when a doc was defer-mounted +
 * V2-cache-rejected (e.g. `BYTES_CACHE_THRESHOLD` reject for multi-MB docs at
 * small `ACTIVITY_MOUNT_LIMIT`), leaving the provider connected and draining
 * peer bytes into the local Y.Doc indefinitely.
 */
let activeProviderPool: {
  entries: ReadonlyMap<string, { provider: HocuspocusProvider }>;
} | null = null;

/** Lookup the provider for a docName: V2 cache first (shared ref), pool fallback. */
function findProvider(docName: string): HocuspocusProvider | null {
  const tip = tiptapCache.get(docName);
  if (tip) return tip.provider;
  const cm = cmCache.get(docName);
  if (cm) return cm.provider;
  if (activeProviderPool) {
    const entry = activeProviderPool.entries.get(docName);
    if (entry) return entry.provider;
  }
  return null;
}

/**
 * Subscribe the editor cache to a pool's eviction events. Returns an
 * unsubscribe function (call on pool teardown to drop the listener and
 * clear the cached pool reference).
 *
 * Two responsibilities:
 *  1. Eviction propagation — the pool fires `onEvict(docName)`; the cache
 *     destroys any cached editor for that doc so `Editor` / `EditorView`
 *     instances cannot outlive the Y.Doc they're bound to.
 *  2. Pool fallback for `findProvider` — the pool's `entries` map is stashed
 *     so `setActivityMountList` can disconnect providers for pool-resident-
 *     but-not-V2-cached docs (correctness under defer-mount + small
 *     `ACTIVITY_MOUNT_LIMIT`).
 *
 * The cache must be subscribed BEFORE the pool can fire any eviction
 * event. The intended call site is right after `new ProviderPool(...)`
 * in `DocumentContext.tsx`, on the `getPool(collabUrl)` path.
 *
 * Single-pool semantic: the most-recent subscription's pool is the one
 * `findProvider` falls back to. In production there's exactly one
 * `ProviderPool` per `collabUrl`, so this matches reality. Tests that need
 * isolation must `unsubscribe()` between cases.
 */
export function subscribePoolEviction(pool: {
  onEvict: (cb: (docName: string) => void) => () => void;
  entries: ReadonlyMap<string, { provider: HocuspocusProvider }>;
}): () => void {
  activeProviderPool = pool;
  const unsubscribeEviction = pool.onEvict((docName) => {
    evictTiptapEditor(docName);
    evictCmEditor(docName);
  });
  return () => {
    unsubscribeEviction();
    if (activeProviderPool === pool) {
      activeProviderPool = null;
    }
  };
}

// ---------------------------------------------------------------------------
// Test helpers (not part of production API)
// ---------------------------------------------------------------------------

/** Test-only: total cache size for one kind. */
export function __getCacheSize(kind: 'tiptap' | 'cm'): number {
  return kind === 'tiptap' ? tiptapCache.size : cmCache.size;
}

/** Test-only: LRU order (oldest first) for one kind. */
export function __getCacheOrder(kind: 'tiptap' | 'cm'): string[] {
  return kind === 'tiptap' ? [...tiptapLru] : [...cmLru];
}

/**
 * Inspect a cached TipTap entry without mutating the cache or LRU. Returns
 * `undefined` for cache MISS, the entry on HIT. Does NOT touch LRU position
 * (peek, not access) — callers that intend a HIT to count as a use should
 * follow up with `mountTiptapEditor` to get reparent + scroll/focus restore.
 *
 * Used by `mount-promise.ts` to branch HIT vs MISS without abusing factory
 * exception flow. Safe in production: read-only Map.get on module-private
 * state; no security boundary.
 */
export function peekTiptap(docName: string): TiptapCacheEntry | undefined {
  return tiptapCache.get(docName);
}

export function __peekCm(docName: string): CmCacheEntry | undefined {
  return cmCache.get(docName);
}

/** Test-only: inspect the current activity mount list. */
export function __getActivityMountList(): string[] {
  return [...activityMountList];
}

/** Test-only: reset all cache state. Destroys live entries. */
export function __resetCacheForTests(): void {
  for (const docName of tiptapCache.keys()) evictTiptapEditor(docName);
  for (const docName of cmCache.keys()) evictCmEditor(docName);
  activityMountList = new Set();
  activeProviderPool = null;
  renameSnapshotStore.clear();
  // Per-entry parking nodes are detached + GC'd with their cache entries
  // above; nothing module-level to clean up here.
}
