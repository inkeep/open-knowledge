/**
 * Slash-command items for registered built-in components.
 *
 * Lists all registered (block) components from the descriptor registry
 * with category grouping and searchTerms fuzzy matching.
 *
 * Inserted components arrive with the props that declare an explicit
 * `defaultValue` populated from the descriptor; everything else stays
 * unset. Synthetic-default fallbacks (first enum value, `0`, `''`,
 * `false`) are NOT applied — they leak into PropPanel as misleading
 * preset values (`width=0`, `crossorigin="anonymous"`, `srcset=""`)
 * that emit to disk on the next dirty serialize. Renderer-side
 * defaults (e.g., `<img>` with no width renders at intrinsic size,
 * `<video controls={true}>` per descriptor's `defaultValue: true`)
 * already cover the "see a Callout / see a Video player" UX without
 * pre-writing the prop bag.
 */

import type { MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { Editor } from '@tiptap/react';
import { CopyPlus, ExternalLink, FileUp, Hash, Link2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { setPendingLinkEdit } from '../extensions/link-edit-autoopen';
import { markIdentityKey } from '../extensions/mark-identity';
import { uploadAndInsert } from '../image-upload/index.ts';
import { getInteractionLayer } from '../interaction-layer-host';
import { resolveIcon } from '../registry/icons.ts';
import { getDescriptor, getRegisteredDescriptors } from '../registry/index.ts';
import type { JsxComponentDescriptor } from '../registry/types.ts';
import type { SlashCommandItem } from './items';
import imagePreview from './preview-assets/image-preview.png';
import videoPreview from './preview-assets/video-preview.png';

/**
 * Per-component hover-preview configuration. Each entry contributes a
 * `description` (rendered as plain text below the visual frame — backticks
 * and other markdown render literally; see `SlashCommandMenu.tsx`)
 * plus EITHER:
 *
 *   - `props` / `children` — the entry's preview is the descriptor's React
 *     component rendered live with these props (e.g. Callout / img / video).
 *     Use this when the live component is cheap and self-contained.
 *
 *   - `render` — a hand-built React element that REPLACES the live render.
 *     Use this when the live component would be too heavy in a hover
 *     preview (PDF.js worker fetch, Mermaid lib load, cross-origin iframe),
 *     OR depends on editor-rendered children that don't exist outside a PM
 *     mount (Tabs reads `data-tab-label` off children's DOM), OR depends
 *     on CSS scoped to `.ProseMirror` ancestors (File row's flex+gap).
 *
 * `props` / `children` are silently ignored when `render` is set — they're
 * mutually exclusive in practice. Keyed by descriptor name (case-sensitive,
 * matches `componentMap` key); components without an entry get no preview
 * panel.
 */
interface PreviewConfig {
  description: MessageDescriptor;
  props?: Record<string, unknown>;
  children?: ReactNode;
  render?: () => ReactNode;
}

const PREVIEW_CONFIG: Record<string, PreviewConfig> = {
  Callout: {
    description: msg`Highlight tips, warnings, and notes.`,
    props: { type: 'note', title: 'Heads up' },
    children: 'Callouts draw attention to key information.',
  },
  Accordion: {
    description: msg`Collapsible section with a clickable summary.`,
    props: { title: 'Click to expand', defaultOpen: true },
    children: 'Hidden content goes here.',
  },
  img: {
    description: msg`Embed an image with optional alt text.`,
    props: { src: imagePreview, alt: 'Sample image' },
  },
  video: {
    description: msg`Embed a video with native player controls.`,
    props: { controls: true, poster: videoPreview },
  },
  audio: {
    description: msg`Embed an audio file with native player controls.`,
    props: { controls: true },
  },
  Math: {
    description: msg`Block math equation rendered with KaTeX from a LaTeX source string.`,
    props: { formula: 'c = \\pm\\sqrt{a^2 + b^2}' },
  },
  Embed: {
    description: msg`Embed an external page in an inline iframe (docs, demos, Figma, CodeSandbox).`,
    // Hand-built browser-pane mockup: chrome bar with traffic-light dots +
    // URL pill, content area with placeholder bars. Live `<Embed>` would
    // spawn an iframe in the hover preview — slow on first paint and
    // X-Frame-Options-blocked for most real URLs.
    render: () => (
      <div className="flex h-full w-full flex-col overflow-hidden rounded-md border border-border bg-background">
        <div className="flex items-center gap-1.5 border-b border-border bg-muted/40 px-2 py-1.5">
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
          <span className="size-1.5 rounded-full bg-muted-foreground/40" />
          <span className="ml-1.5 flex-1 truncate rounded-sm bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            https://example.com/embed
          </span>
        </div>
        <div className="flex flex-1 flex-col justify-center gap-1.5 px-3 py-2">
          <span className="h-1.5 w-3/4 rounded-sm bg-muted-foreground/30" />
          <span className="h-1.5 w-full rounded-sm bg-muted-foreground/20" />
          <span className="h-1.5 w-5/6 rounded-sm bg-muted-foreground/20" />
          <span className="h-1.5 w-2/3 rounded-sm bg-muted-foreground/20" />
        </div>
      </div>
    ),
  },
  Pdf: {
    description: msg`Multi-page PDF viewer with toolbar controls (thumbnails, page nav, zoom).`,
    // Hand-built viewer mockup: toolbar (thumbnail toggle / page nav /
    // zoom) + thumbnail strip + page content. Live `<Pdf>` would fetch
    // `pdfjs-dist` worker bytes and a sample PDF over the network on
    // every menu open.
    render: () => (
      <div className="flex h-full w-full flex-col overflow-hidden rounded-md border border-border bg-background">
        <div className="flex items-center gap-1 border-b border-border bg-muted/40 px-1.5 py-1">
          {/* Thumbnails toggle (2x2 dots) */}
          <svg viewBox="0 0 12 12" className="size-3 text-muted-foreground" aria-hidden="true">
            <title>Thumbnails</title>
            <rect x="1" y="1" width="4" height="4" fill="currentColor" rx="0.5" />
            <rect x="7" y="1" width="4" height="4" fill="currentColor" rx="0.5" />
            <rect x="1" y="7" width="4" height="4" fill="currentColor" rx="0.5" />
            <rect x="7" y="7" width="4" height="4" fill="currentColor" rx="0.5" />
          </svg>
          <span className="ml-1 flex items-center gap-1 text-[10px] text-muted-foreground">
            <span className="rounded-sm bg-background px-1 py-0.5 font-mono">2</span>
            <span>/ 12</span>
          </span>
          <span className="ml-auto flex items-center gap-1 text-[10px] font-mono text-muted-foreground">
            <span className="rounded-sm bg-background px-1 py-0.5">−</span>
            <span>100%</span>
            <span className="rounded-sm bg-background px-1 py-0.5">+</span>
          </span>
        </div>
        <div className="flex flex-1 gap-1 p-1.5">
          {/* Thumbnail strip */}
          <div className="flex w-6 flex-col gap-0.5">
            <span className="h-3 rounded-sm bg-muted-foreground/20" />
            <span className="h-3 rounded-sm border border-foreground/60 bg-background" />
            <span className="h-3 rounded-sm bg-muted-foreground/20" />
          </div>
          {/* Active page */}
          <div className="flex flex-1 flex-col gap-1 rounded-sm bg-background p-1.5">
            <span className="h-1.5 w-1/2 rounded-sm bg-foreground/50" />
            <span className="h-1 w-full rounded-sm bg-muted-foreground/30" />
            <span className="h-1 w-5/6 rounded-sm bg-muted-foreground/30" />
            <span className="h-1 w-full rounded-sm bg-muted-foreground/30" />
            <span className="h-1 w-2/3 rounded-sm bg-muted-foreground/30" />
          </div>
        </div>
      </div>
    ),
  },
  MermaidFence: {
    description: msg`Diagram from Mermaid source — flowchart, sequence, class, state, ER, gantt, pie.`,
    // Hand-built flowchart SVG: 3-node Start → Decision → End with
    // labeled connector arrows. Live Mermaid render would async-load the
    // `mermaid` lib + parse + lay out, blocking the menu's first paint.
    // `currentColor` lets the SVG inherit the popover's text color.
    render: () => (
      <svg
        viewBox="0 0 200 120"
        className="h-full w-full text-foreground"
        aria-hidden="true"
        preserveAspectRatio="xMidYMid meet"
      >
        <title>Mermaid flowchart preview</title>
        <defs>
          <marker
            id="mermaid-preview-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        {/* Start (rounded) */}
        <rect
          x="14"
          y="20"
          width="56"
          height="28"
          rx="14"
          fill="currentColor"
          fillOpacity="0.1"
          stroke="currentColor"
          strokeOpacity="0.7"
        />
        <text x="42" y="38" textAnchor="middle" fontSize="10" fill="currentColor">
          Start
        </text>
        {/* Decision (diamond) */}
        <polygon
          points="100,18 140,50 100,82 60,50"
          fill="currentColor"
          fillOpacity="0.1"
          stroke="currentColor"
          strokeOpacity="0.7"
        />
        <text x="100" y="54" textAnchor="middle" fontSize="10" fill="currentColor">
          Ready?
        </text>
        {/* End (rounded) */}
        <rect
          x="130"
          y="84"
          width="56"
          height="28"
          rx="14"
          fill="currentColor"
          fillOpacity="0.1"
          stroke="currentColor"
          strokeOpacity="0.7"
        />
        <text x="158" y="102" textAnchor="middle" fontSize="10" fill="currentColor">
          End
        </text>
        {/* Edges */}
        <line
          x1="70"
          y1="34"
          x2="80"
          y2="40"
          stroke="currentColor"
          strokeOpacity="0.7"
          strokeWidth="1.2"
          markerEnd="url(#mermaid-preview-arrow)"
        />
        <line
          x1="124"
          y1="62"
          x2="138"
          y2="82"
          stroke="currentColor"
          strokeOpacity="0.7"
          strokeWidth="1.2"
          markerEnd="url(#mermaid-preview-arrow)"
        />
        <text x="138" y="74" fontSize="8" fill="currentColor" opacity="0.6">
          yes
        </text>
      </svg>
    ),
  },
  Tabs: {
    description: msg`Horizontal pill strip + active panel below; click a pill to switch panels.`,
    // Hand-built pill-strip mockup. Live `<Tabs>` reads tab labels from
    // PM-rendered children with `data-tab-label` attributes, which don't
    // exist outside an editor mount.
    render: () => (
      <div className="space-y-1.5">
        <div className="flex gap-1 border-b border-border pb-1">
          <span className="rounded-md bg-foreground/10 px-2 py-0.5 text-xs font-medium text-foreground">
            Tab 1
          </span>
          <span className="rounded-md px-2 py-0.5 text-xs text-muted-foreground">Tab 2</span>
        </div>
        <p className="px-1 text-xs text-muted-foreground">
          <Trans>Active panel content for the selected tab shows here.</Trans>
        </p>
      </div>
    ),
  },
  Mirror: {
    // Backticks render literally in the preview description (see PreviewConfig
    // JSDoc); peer descriptions avoid them. Refer to the partner descriptor
    // by name, not code-quoted JSX.
    description: msg`Read-only copy of a MirrorSource block from another doc. Edit at the source and it updates live.`,
    // Hand-built mockup. Live `<Mirror>` needs a real source doc + a
    // HocuspocusProvider to resolve, which doesn't exist in the preview pane.
    render: () => (
      <div className="space-y-1.5">
        <div className="relative rounded-md border border-dashed border-border/40 px-2 py-1.5">
          <span className="absolute -top-2 right-1.5 flex items-center gap-1 rounded-md bg-background px-1 text-[10px] text-muted-foreground">
            <ExternalLink className="size-2.5" aria-hidden="true" />
            <span>
              <Trans>
                Mirror of <code className="font-mono">api-spec</code>
              </Trans>
            </span>
          </span>
          <span className="block h-1.5 w-3/4 rounded-sm bg-muted-foreground/30" />
          <span className="mt-1 block h-1.5 w-2/3 rounded-sm bg-muted-foreground/20" />
        </div>
        <p className="px-1 text-[10px] text-muted-foreground">
          <Trans>Edits at the source land here — no copy-paste drift.</Trans>
        </p>
      </div>
    ),
  },
  MirrorSource: {
    description: msg`Mark a block as the source of truth. Mirrors elsewhere update live as you edit it.`,
    // Hand-built mockup. The live component is a passthrough container that
    // renders its children inline — in the slash preview pane (no real
    // children, no surrounding doc), the live render would just be an empty
    // dashed box. The mockup shows what authors see when there IS content
    // inside: badge in the corner + the actual content lines.
    render: () => (
      <div className="space-y-1.5">
        <div className="relative rounded-md border border-dashed border-border/50 px-2 py-1.5">
          <span className="absolute -top-2 left-1.5 flex items-center gap-1 rounded-md bg-background px-1 text-[10px] text-muted-foreground">
            <CopyPlus className="size-2.5" aria-hidden="true" />
            <span>
              <Trans>
                Mirror source <code className="font-mono">api-spec</code>
              </Trans>
            </span>
          </span>
          <span className="block h-1.5 w-4/5 rounded-sm bg-muted-foreground/30" />
          <span className="mt-1 block h-1.5 w-3/5 rounded-sm bg-muted-foreground/20" />
        </div>
        <p className="px-1 text-[10px] text-muted-foreground">
          <Trans>Authoritative content; mirrored verbatim everywhere it's referenced.</Trans>
        </p>
      </div>
    ),
  },
};

/**
 * Compute default props for slash-inserted components.
 *
 * Only props that DECLARE an explicit `defaultValue` get pre-populated.
 * Undeclared props stay unset so PropPanel renders them as empty inputs
 * (string), empty number fields, false-checked switches, and "(unset)"-
 * equivalent enum dropdowns — and they don't emit to disk on the next
 * serialize. The synthetic-default fallback ladder (first enum value,
 * `0`, `''`, `false`) was leaking misleading preset values:
 *   - `width=0` / `height=0` collapsed inserted images to invisible.
 *   - `crossorigin="anonymous"` enabled CORS the user didn't request.
 *   - `srcset=""` / `sizes=""` cluttered the on-disk MDX after first save.
 * Renderer-side defaults (declared `defaultValue` like
 * `<video controls={true}>` or HTML platform defaults like `<img>` at
 * intrinsic size) already cover the "see a Callout / Video / Image" UX
 * without pre-writing the prop bag.
 */
function getDefaultProps(descriptor: JsxComponentDescriptor): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const prop of descriptor.props) {
    if (prop.type === 'reactnode') continue;
    if ('defaultValue' in prop && prop.defaultValue !== undefined) {
      defaults[prop.name] = prop.defaultValue;
    }
  }
  return defaults;
}

/**
 * Build the PM content JSON for a component node with default props.
 * Used by: slash-command insertion, BlockDragHandle "+" container child insertion,
 * empty-container placeholder, and "add child" button — single source of truth.
 * Derives everything from the descriptor; zero component-specific logic.
 */
export function createChildNode(childName: string): Record<string, unknown> {
  const childDesc = getDescriptor(childName);
  const defaultProps = getDefaultProps(childDesc);
  return {
    type: 'jsxComponent',
    attrs: {
      componentName: childDesc.name,
      kind: 'element',
      attributes: [],
      sourceRaw: '',
      sourceDirty: true,
      props: defaultProps,
    },
    content: childDesc.hasChildren ? [{ type: 'paragraph' }] : undefined,
  };
}

/**
 * Pending auto-open queue, keyed by the inserted NodeSelection's document
 * position. A boolean flag used to break under rapid successive slash
 * insertions — the second insertion set the flag before the first
 * consumed it, so the NodeView that mounted second stole the auto-open
 * while the first never got one. Keying by position avoids that race:
 * each insertion tracks its own pending-ness, and consumption is a
 * `.delete(key)` — two different NodeViews can't collide.
 *
 * The map is bounded by typical usage (1–2 pending at a time under
 * keyboard burst). An explicit cap would shed oldest entries; skipped
 * because the set is effectively self-pruning (every NodeView that
 * mounts calls `consumeAutoOpen` with its pos once).
 */
const pendingAutoOpen = new Set<number>();

export function setPendingAutoOpen(pos: number): void {
  pendingAutoOpen.add(pos);
}

/**
 * Internal test-only helper: clear the pending set. Production code should
 * not call this — `consumeAutoOpen` drains entries as NodeViews mount.
 */
export function _resetPendingAutoOpenForTest(): void {
  pendingAutoOpen.clear();
}

/**
 * Consume the auto-open flag for the NodeView at `pos`. Returns true once;
 * subsequent calls for the same pos return false. Legacy callers that pass
 * no argument drain any pending flag (used by the slash-insert path where
 * the NodeView doesn't yet know its final position).
 */
export function consumeAutoOpen(pos?: number): boolean {
  if (typeof pos === 'number') {
    return pendingAutoOpen.delete(pos);
  }
  // No position provided — legacy drain behavior for callers that cannot
  // resolve their getPos() yet. Takes an arbitrary entry; safe because
  // the caller only checks the flag's truthiness, not identity.
  const iter = pendingAutoOpen.values().next();
  if (iter.done) return false;
  pendingAutoOpen.delete(iter.value);
  return true;
}

/**
 * After inserting a component, focus appropriately:
 * - Has editable props → NodeSelect the component (triggers popover auto-open)
 * - Has children only → place cursor inside children for typing
 */
export function focusInsertedComponent(
  editor: Editor,
  insertPos: number,
  descriptor: JsxComponentDescriptor,
): void {
  const hasEditableProps = descriptor.props.some(
    (p) => !('hidden' in p && p.hidden) && p.type !== 'reactnode',
  );

  if (hasEditableProps) {
    setPendingAutoOpen(insertPos);
    requestAnimationFrame(() => {
      editor.commands.setNodeSelection(insertPos);
    });
  } else if (descriptor.hasChildren) {
    editor.commands.setTextSelection(insertPos + 2);
  }
}

/**
 * Create the slash-command insertion command for a component.
 * Inserts a jsxComponent PM node with structured attrs + default props.
 * Post-insert: auto-opens PropPanel (editable props) or focuses children.
 */
function createInsertCommand(descriptor: JsxComponentDescriptor): (editor: Editor) => void {
  return (editor: Editor) => {
    // Snapshot existing matching jsxComponent node references. ProseMirror
    // preserves node identity for nodes unchanged by a transaction, so the
    // matching node in the new doc whose reference is NOT in this set is
    // the one just inserted. This is robust whether the cursor lands before
    // or after the new node, and across multi-instance docs where
    // cursor-relative heuristics misidentify which match is new.
    //
    // The boundary position must come from the post-insert doc anyway:
    // selection.from BEFORE insertion is the cursor's interior position
    // (e.g., 1 inside an empty paragraph), which doc.nodeAt() rejects as
    // a NodeSelection target — and the consumer's consumeAutoOpen(getPos())
    // keys off the boundary position regardless.
    const beforeRefs = new WeakSet<object>();
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'jsxComponent' && node.attrs.componentName === descriptor.name) {
        beforeRefs.add(node);
      }
    });

    // Tabs is the only compound parent in the canonical pack today, so its
    // slash insertion seeds two starter `<Tab>` children rather than the
    // generic single-empty-paragraph default. An empty `<Tabs>` would render
    // a stray paragraph outside any tab panel; the strip needs at least one
    // labeled child. If a SECOND compound parent ships, replace this
    // hardcoded check with a declarative descriptor field (e.g.
    // `seededChildren?: Array<{ name; defaultProps? }>`) — the
    // single-instance carve-out below is intentionally not generalized
    // until that pressure exists.
    const inserted = createChildNode(descriptor.name);
    if (descriptor.name === 'Tabs') {
      const tab1 = createChildNode('Tab');
      const tab2 = createChildNode('Tab');
      const tab1Attrs = tab1.attrs as Record<string, unknown>;
      const tab2Attrs = tab2.attrs as Record<string, unknown>;
      tab1Attrs.props = { ...(tab1Attrs.props as Record<string, unknown>), label: 'Tab 1' };
      tab2Attrs.props = { ...(tab2Attrs.props as Record<string, unknown>), label: 'Tab 2' };
      (inserted as Record<string, unknown>).content = [tab1, tab2];
    }
    editor.chain().focus().insertContent(inserted).run();

    let insertPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (insertPos >= 0) return false;
      if (
        node.type.name === 'jsxComponent' &&
        node.attrs.componentName === descriptor.name &&
        !beforeRefs.has(node)
      ) {
        insertPos = pos;
      }
    });

    if (insertPos < 0) return;
    focusInsertedComponent(editor, insertPos, descriptor);
  };
}

/**
 * Build slash-command items from the registered descriptor registry.
 * Called lazily by the slash-command extension's itemsSources API.
 *
 * Filters to `surface: 'canonical'` — compat descriptors (GFMCallout,
 * CommonMarkImage, HtmlDetailsAccordion) are read-only round-trip preservers
 * for content authored in those source forms; never offered for fresh
 * insertion. To get a canonical with the full prop surface, the user inserts
 * a fresh canonical block from this menu.
 */
/**
 * Canonicals that are NOT offered as JSX-form slash inserts. The descriptor
 * still exists in the registry as a render-dispatch target for one or more
 * compats (e.g. `File` is the canonical that `WikiEmbedFile` renders
 * through), but the user-facing slash menu offers a CUSTOM entry whose
 * insert command produces the compat's source-form shape (`![[file.ext]]`)
 * instead of the canonical JSX (`<File src="" />`).
 */
// `Tab` is canonical but only meaningful nested inside `<Tabs>` — orphan
// insertion via slash menu would create a dangling panel. Users add tabs by
// duplicating an existing Tab via the drag-handle, OR by editing source.
// `File` stays hidden because the file-upload affordance has its own slash
// entry that opens an OS picker.
export const SLASH_HIDDEN_CANONICALS: ReadonlySet<string> = new Set(['File', 'Tab']);

/**
 * Custom block-level slash entries for canonicals whose user-facing
 * insertion path is not the JSX-form descriptor default. Each entry
 * pairs a canonical (rendered via the descriptor registry) with a
 * hand-written insert command that produces a different source-form
 * shape.
 *
 * Today's only entry — `File` — opens a file picker, runs the upload
 * pipeline, and inserts a `jsxComponent('WikiEmbedFile')` block whose
 * serialize emits `![[file.ext]]`. Convergent with drag-drop: same
 * upload + same render. Hand-authored `<File>` JSX still works (the
 * canonical exists), but slash never inserts that form.
 */
function getCustomBlockComponentItems(): SlashCommandItem[] {
  return [
    {
      name: 'component-File',
      label: t`File`,
      icon: FileUp,
      category: 'media',
      aliases: ['file', 'attachment', 'download', 'upload', 'document', 'doc', 'docx', 'zip'],
      description: 'Attach a downloadable file (`.pdf` / `.docx` / `.zip` / …)',
      command: openFilePickerAndUpload,
      preview: {
        description: t`Notion-style inline row for a downloadable file. Drag-drop also works.`,
        // Hand-mocked row rather than rendering `<File>` directly — the
        // real component's flex+gap layout is declared on
        // `.ProseMirror a.ok-file-attachment`, which doesn't apply inside
        // the slash menu's preview pane (no `.ProseMirror` ancestor).
        // Rendering the real component there produces a name/size pair
        // jammed together with no separator.
        render: () => (
          <div className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5">
            <FileUp className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate font-medium text-foreground">quarterly-report.pdf</span>
            <span className="shrink-0 text-xs text-muted-foreground">1.4 MB</span>
          </div>
        ),
      },
    },
  ];
}

export function getComponentItems(): SlashCommandItem[] {
  const descriptors = getRegisteredDescriptors().filter(
    (desc) => desc.surface === 'canonical' && !SLASH_HIDDEN_CANONICALS.has(desc.name),
  );

  const descriptorItems = descriptors.map((desc) => {
    const config = PREVIEW_CONFIG[desc.name];
    const Component = desc.Component;
    // `config.render` is the hand-mocked path (used when the live component
    // is too heavy for a hover preview, see PreviewConfig JSDoc); when
    // absent, fall back to the live `<Component {...props}>` render.
    const preview: SlashCommandItem['preview'] = config
      ? {
          description: t(config.description),
          render:
            config.render ?? (() => <Component {...config.props}>{config.children}</Component>),
        }
      : undefined;

    return {
      name: `component-${desc.name}`,
      label: desc.displayName ?? desc.name,
      icon: resolveIcon(desc.icon),
      category: desc.category ?? 'content',
      command: createInsertCommand(desc),
      aliases: desc.searchTerms,
      description: desc.description,
      preview,
    };
  });

  return [...descriptorItems, ...getCustomBlockComponentItems()];
}

/**
 * Trigger the OS file-picker programmatically and pipe the chosen file
 * into the upload pipeline (`uploadAndInsert`). Same flow as drag/drop
 * a file onto the editor — the only difference is the entry point.
 *
 * The picker's `accept` attribute is set to all-types (matching `File`'s
 * descriptor `accept`) so the OS dialog shows every file. The uploaded
 * asset is inserted at the cursor's current position.
 */
function openFilePickerAndUpload(editor: Editor): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '*/*';
  input.style.display = 'none';
  input.addEventListener(
    'change',
    () => {
      const file = input.files?.[0];
      if (file) {
        const insertPos = editor.state.selection.from;
        // Fire-and-forget — `uploadAndInsert` owns its own error toasts
        // + skeleton-widget cleanup. The slash command returns
        // synchronously so the menu closes immediately.
        void uploadAndInsert(file, editor, insertPos);
      }
      input.remove();
    },
    { once: true },
  );
  // `cancel` fires when the user dismisses the OS file dialog without
  // selecting a file — without this, the hidden `<input>` would orphan
  // in `document.body` on every cancelled pick. Modern browsers all
  // support the event (Chrome 119+, Firefox 91+, Safari 15.4+).
  input.addEventListener('cancel', () => input.remove(), { once: true });
  document.body.appendChild(input);
  input.click();
}

/**
 * Resolve the stable mark id of a `link` mark covering `pos` from the
 * mark-identity plugin state. IDs are assigned synchronously during the
 * dispatch that inserts the mark, so this reads them off `editor.state`
 * immediately after the insert chain runs. Returns null when the plugin
 * isn't installed (non-app editors / tests) or no link mark covers `pos` —
 * callers degrade gracefully (the link is still inserted; only the
 * auto-open is skipped).
 */
function findLinkMarkIdAt(editor: Editor, pos: number): string | null {
  const state = markIdentityKey.getState(editor.state);
  if (!state) return null;
  for (const info of state.byId.values()) {
    if (info.markType === 'link' && info.from <= pos && pos < info.to) {
      return info.id;
    }
  }
  return null;
}

/**
 * Slash-menu items for inline-only PM atoms. Block components flow
 * through the descriptor registry (`getComponentItems()`); inline atoms
 * like `tag` aren't in the registry — they map directly to PM nodes
 * via the `mdxJsxTextElement` short-circuit in `markdown/index.ts` —
 * so their slash entries are hand-authored here.
 *
 * The `Tag` entry inserts an empty `tag` atom; the NodeView's
 * placeholder state then takes over with an auto-focused inline input
 * (see `editor/components/TagView.tsx`). No PropPanel popover, no
 * `setPendingAutoOpen` plumbing — focus management lives in the
 * NodeView's mount effect, not in a queued auto-open flag.
 *
 * This is one of two insertion paths to a filled tag atom; the other
 * is the inline `#` typeahead (`tag-suggestion.ts`), which lands a
 * pre-filled atom and never touches the placeholder state.
 */
export function getInlineComponentItems(): SlashCommandItem[] {
  return [
    {
      // Link — lands a placeholder `link` chip carrying a `link` mark, then
      // auto-opens the markdown-link editor. The dialog starts with an empty
      // target so the user can choose a page path or external URL in one flow.
      name: 'link',
      label: t`Link`,
      icon: Link2,
      category: 'insert',
      aliases: [
        'url',
        'href',
        'external',
        'web',
        'hyperlink',
        'wiki',
        'wikilink',
        '[[',
        'internal',
        'page',
        'backlink',
        'cross-link',
      ],
      description: 'Link to a page or external URL',
      preview: {
        description: t`Link to a page or external URL.`,
        render: () => (
          <p className="leading-7 text-sm">
            <Trans>
              See{' '}
              <span className="font-medium text-azure-blue underline underline-offset-2 dark:text-sky-blue">
                Architecture
              </span>{' '}
              for the system overview.
            </Trans>
          </p>
        ),
      },
      command: (editor: Editor) => {
        const insertPos = editor.state.selection.from;
        editor
          .chain()
          .focus()
          .insertContent({
            type: 'text',
            text: 'link',
            marks: [{ type: 'link', attrs: { href: '' } }],
          })
          .run();

        const markId = findLinkMarkIdAt(editor, insertPos);
        if (!markId) return;
        setPendingLinkEdit(markId);
        requestAnimationFrame(() => {
          getInteractionLayer(editor).setActiveNode(markId);
        });
      },
    },
    {
      name: 'component-Tag',
      label: t`Tag`,
      icon: Hash,
      category: 'content',
      aliases: ['#', 'hashtag', 'label'],
      description: 'Inline tag (`#tagname`) for cross-doc linking',
      preview: {
        description: t`Inline hashtag for cross-doc grouping.`,
        // Hand-built `<a className="tag">` mirroring TagView's
        // `RenderedTagChip` shape — using the real RenderedTagChip
        // would require an `<a>` href + click handler that misfires in
        // the slash menu's preview frame, where the menu intercepts
        // mousedown to keep editor focus.
        render: () => (
          <p className="text-sm leading-7">
            <Trans>
              See{' '}
              {/* biome-ignore lint/a11y/useValidAnchor: preview mockup of an <a className="tag"> — no real navigation target needed inside the slash menu's pointer-events-none preview frame */}
              <a className="tag pointer-events-none">#design-docs</a> for the latest specs.
            </Trans>
          </p>
        ),
      },
      command: (editor: Editor) => {
        // Insert an empty `tag` atom WITHOUT a leading `chain().focus()`.
        // The NodeView's mount effect (deferred via rAF) pulls focus
        // into the placeholder's inline input on the next frame; an
        // explicit editor-focus here would race with that and leave
        // the cursor past the atom instead. Insertion proceeds even
        // without the explicit focus because PM's selection is still
        // valid from the slash command's own match range.
        editor.chain().insertTag('').run();
      },
    },
  ];
}
