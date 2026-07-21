/**
 * WYSIWYG clipboard serialization — the copy/cut/dragstart output side.
 *
 * Two hooks on `editorProps` (see TiptapEditor.tsx):
 *
 *   - `clipboardTextSerializer(slice, view) → string` — emits text/plain.
 *     Wraps the slice's content in a transient doc node, serializes to
 *     markdown via MarkdownManager.serialize.
 *
 *   - `clipboardSerializer.serializeFragment(fragment) → DocumentFragment` —
 *     emits text/html. Walker-first: when an EditorView has been attached
 *     via `setView()`, the live-DOM walker captures whatever React
 *     rendered + whatever CSS resolved (the React render IS the cross-app
 *     HTML shape for the v1 5-pack and 3 compat descriptors). Without an
 *     attached view (first render before `onCreate` fires, or unit-test
 *     mounts with no view), falls through to the markdown→HTML pipeline.
 *     Either way, returns the content directly (no wrapper element): PM's
 *     `serializeForClipboard` (`prosemirror-view/src/clipboard.ts:32-34`)
 *     sets `data-pm-slice` on the first element of whatever we return and
 *     computes the `openStart openEnd context` value from the slice
 *     itself — PM's value is authoritative.
 *
 * Error-path discipline:
 *   - text serializer throw → fall through to PM's default textBetween.
 *   - HTML walker throw → fall through to the markdown→HTML pipeline.
 *   - HTML serializer throw → return empty DocumentFragment. Cross-app
 *     destinations receive empty text/html and fall back to text/plain
 *     (written by clipboardTextSerializer). User can still paste; only
 *     rich-HTML fidelity is lost.
 */

import type { MarkdownManager } from '@inkeep/open-knowledge-core';
import { markdownToHtml } from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import type { Node, ResolvedPos, Schema, Slice } from '@tiptap/pm/model';
import { DOMSerializer, Fragment, Slice as SliceCtor } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';
import {
  type SerializeResult,
  type WalkerEnv,
  walkLiveDomToInlineStyledFragment,
} from './clipboard-walker.ts';
import {
  stripClipboardOmitted,
  stripClipboardOmittedFromFragment,
  stripClipboardOmittedFromNode,
} from './comment-scrub.ts';
import { classifyError, logSerializeFail } from './instrument.ts';

interface WysiwygSerializerDeps {
  mdManager: MarkdownManager;
}

/**
 * The HTML serializer factory returns this shape so the caller (TiptapEditor)
 * can attach the live `EditorView` after `editor.on('create')` fires. PM's
 * `clipboardSerializer` is set at editor construction — earlier than `view`
 * is available — so we hand back the serializer plus a setter the host calls
 * once the view is mounted.
 */
export interface ClipboardHtmlSerializerHandle {
  serializer: DOMSerializer;
  setView: (view: EditorView) => void;
}

/**
 * Build `clipboardTextSerializer`. Closes over the shared MarkdownManager;
 * the schema is read from the EditorView at call time, so the hook is safe
 * to construct before the editor mounts.
 */
export function createClipboardTextSerializer(deps: WysiwygSerializerDeps) {
  return (rawSlice: Slice, view: EditorView): string => {
    // Clipboard-omitted content (comment annotations) must not reach the
    // text/plain payload; scrub once at entry so every path below —
    // including the textBetween fallback — serializes the clean slice.
    const slice = stripClipboardOmitted(rawSlice, view.state.schema);
    // CellSelection copies belong to the table clipboard convention, not
    // to the markdown pipeline. `\t`-separated cells / `\n`-separated
    // rows is what browsers and spreadsheets (Excel, Sheets, Numbers)
    // exchange as `text/plain`; it also pastes cleanly into GitHub /
    // Slack. The default markdown path serializes tableRow / tableCell
    // fragments as top-level doc content, which the schema rejects, so
    // the text collapses to the concatenated cell strings and paste-
    // side loses column boundaries entirely.
    //
    // Wrapped in try/catch to match the file's documented error-path
    // discipline (see header): text-serializer throw → fall through to
    // markdown / PM textBetween. `forEachCell` and `resolve(pos).before()`
    // are the throw surfaces here; both are low-probability but real
    // (RangeError on a stale position after a race with a remote edit).
    if (view.state.selection instanceof CellSelection) {
      try {
        return serializeCellSelectionAsText(view.state.selection);
      } catch (err) {
        logSerializeFail({
          view: 'wysiwyg',
          kind: 'text',
          reason: `cellselection:${(err as Error)?.message ?? 'unknown'}`,
        });
        // Fall through to the markdown path below.
      }
    }
    // A text selection *inside* a syntax-bearing block (drag-highlighting
    // text within a table cell, blockquote, heading, list item, code block,
    // footnote definition, …). `selection.content()` returns the enclosing
    // ancestor chain with open depths — PM's encoding of "these ancestors are
    // only partially covered" — and the markdown path below discards those
    // depths, so it would emit the ancestors' block syntax (pipes + delimiter
    // row, `> `, `# `, `- `, code fences) instead of just the highlighted
    // text. Peel the partially-covered wrappers and serialize the interior
    // content: inline formatting (`code`, **strong**, …) is preserved exactly
    // as it is when copying from a paragraph, only the block structure the
    // selection never fully covered is dropped.
    if (view.state.selection instanceof TextSelection && !view.state.selection.empty) {
      try {
        const stripped = stripEnclosingMarkerWrappers(slice, view.state);
        if (stripped !== slice) {
          return sliceToMarkdown(stripped, view.state.schema, deps.mdManager);
        }
      } catch (err) {
        logSerializeFail({
          view: 'wysiwyg',
          kind: 'text',
          reason: `interior:${(err as Error)?.message ?? 'unknown'}`,
        });
        // Fall through to the markdown path below.
      }
    }
    try {
      return sliceToMarkdown(slice, view.state.schema, deps.mdManager);
    } catch (err) {
      logSerializeFail({
        view: 'wysiwyg',
        kind: 'text',
        reason: (err as Error)?.message ?? 'unknown',
      });
      return slice.content.textBetween(0, slice.content.size, '\n\n');
    }
  };
}

export function serializeCellSelectionAsText(selection: CellSelection): string {
  const rows: string[][] = [];
  let currentRowTop: number | null = null;
  let currentRow: string[] = [];
  selection.forEachCell((cell, pos) => {
    const rowTop = selection.$anchorCell.doc.resolve(pos).before();
    if (currentRowTop === null || rowTop !== currentRowTop) {
      if (currentRow.length > 0) rows.push(currentRow);
      currentRow = [];
      currentRowTop = rowTop;
    }
    currentRow.push(encodeTsvField(cellText(cell)));
  });
  if (currentRow.length > 0) rows.push(currentRow);
  return rows.map((r) => r.join('\t')).join('\n');
}

/**
 * A cell's text with its internal line breaks preserved. PM's `textContent`
 * renders a `hardBreak` leaf as the empty string, so `line1<br>line2` would
 * flush-concatenate to `"line1line2"`. `textBetween` with a block separator of
 * `\n` (between paragraphs) and a `hardBreak` leafText of `\n` keeps every
 * in-cell break as a real newline.
 */
function cellText(cell: Node): string {
  const scrubbed = stripClipboardOmittedFromNode(cell, cell.type.schema);
  return scrubbed.textBetween(0, scrubbed.content.size, '\n', (leaf) =>
    leaf.type.name === 'hardBreak' ? '\n' : '',
  );
}

const TABLE_WRAPPER_TYPES = new Set(['table', 'tableRow', 'tableCell', 'tableHeader']);

/**
 * Marker-bearing wrapper nodes whose syntax must not leak from a partial
 * interior selection, but which the user CAN mean as a whole (selecting a
 * list's entire text should still copy list markers). Peeled only when the
 * selection covers a strict subset of the wrapper's text. Table wrappers are
 * handled separately (unconditional peel): a lone `tableCell` fragment is not
 * independently serializable markdown, so stopping mid-chain would corrupt
 * the output.
 */
const STRIPPABLE_WRAPPER_TYPES = new Set(['blockquote', 'list', 'listItem', 'footnoteDefinition']);

/**
 * True when the selection spans every text character of the node at `depth`
 * (an ancestor of both endpoints): no text of that node lies outside
 * [from, to]. Leaf atoms count via the leaf-text placeholder so an image-only
 * remainder still reads as uncovered content.
 */
function selectionCoversAllTextOf($from: ResolvedPos, $to: ResolvedPos, depth: number): boolean {
  const doc = $from.doc;
  return (
    doc.textBetween($from.start(depth), $from.pos, '\n', '￼') === '' &&
    doc.textBetween($to.pos, $to.end(depth), '\n', '￼') === ''
  );
}

/**
 * Peel partially-covered marker-bearing ancestors off the front of an open
 * slice, returning a slice of the interior content with the open depths
 * adjusted. Generalizes the original table-only strip: the loop only descends
 * while the slice is a single wrapper open on both ends — the shape
 * `selection.content()` produces for a selection inside one block — so a
 * fully-selected structure (closed slice) or a multi-block fragment is
 * returned unchanged and still serializes with its own syntax.
 *
 * Peel policy per level, anchored to the live selection (slice shape alone
 * cannot distinguish "interior cut" from "whole structure selected" — both
 * yield a single-child open-both-ends chain):
 *   - table wrapper chain → peel unconditionally (a bare cell/row fragment
 *     is not serializable markdown on its own);
 *   - textblock (heading, codeBlock, paragraph) → peel (its syntax never
 *     survives a text-level cut);
 *   - other marker-bearing wrappers → peel only while the selection covers a
 *     strict subset of the wrapper's text. First-char-to-last-char
 *     whole-list/whole-quote selections keep their markers, and a selection
 *     spanning exactly one list item's text keeps that item (the list-sibling
 *     paste splice consumes the `- [ ] item` payload of a full-item copy —
 *     see handle-paste.list-placement tests).
 * A fully-covered `listItem` cannot stand alone as doc content, so stopping
 * there restores the enclosing list peeled the iteration before (the slice's
 * list carries only the covered items). A depth-mapping mismatch stops the
 * loop (fail-safe: under-peel falls back to the pre-existing full-structure
 * output).
 */
export function stripEnclosingMarkerWrappers(slice: Slice, state: EditorState): Slice {
  const selection = state.selection;
  if (!(selection instanceof TextSelection) || selection.empty) return slice;
  const { $from, $to } = selection;
  let content = slice.content;
  let openStart = slice.openStart;
  let openEnd = slice.openEnd;
  let prev: { content: Fragment; openStart: number; openEnd: number } | null = null;
  // Doc depth of the outermost open wrapper in the slice ($from-side chain).
  let depth = $from.depth - slice.openStart + 1;
  while (openStart > 0 && openEnd > 0) {
    const only = content.firstChild;
    if (content.childCount !== 1 || only === null) break;
    if (depth < 1 || depth > $from.depth || $from.node(depth).type !== only.type) break;
    let peel: boolean;
    if (TABLE_WRAPPER_TYPES.has(only.type.name) || only.isTextblock) {
      peel = true;
    } else if (STRIPPABLE_WRAPPER_TYPES.has(only.type.name)) {
      if (selectionCoversAllTextOf($from, $to, depth)) {
        // Whole structure meant. A bare listItem is not valid top-level doc
        // content — restore the list wrapper peeled one step earlier.
        if (only.type.name === 'listItem' && prev !== null) {
          ({ content, openStart, openEnd } = prev);
        }
        break;
      }
      peel = true;
    } else {
      break;
    }
    if (!peel) break;
    prev = { content, openStart, openEnd };
    content = only.content;
    openStart -= 1;
    openEnd -= 1;
    depth += 1;
  }
  if (content === slice.content) return slice;
  return new SliceCtor(content, openStart, openEnd);
}

/**
 * Encode one TSV field per the Excel / Google Sheets clipboard convention
 * (RFC 4180 §2.5-2.7 with a tab delimiter): a field containing a newline, a
 * tab, or a double quote is wrapped in double quotes with internal quotes
 * doubled, so its embedded newline is not confused with the row separator.
 * Single-line cells with no special character stay unquoted — byte-identical to
 * the prior `textContent` output.
 *
 * Spreadsheet formula injection (a cell starting with `=` / `+` / `-` / `@`)
 * is deliberately NOT neutralized here — an accepted risk, not an oversight.
 * This is clipboard copy-out consumed by every destination, not a CSV file
 * export: the classic `'`-prefix mitigation would visibly corrupt legitimate
 * cells (negative numbers, `+3%` deltas, list-style text) pasted into
 * editors, chat, or OK itself, and RFC 4180 quoting alone never disarms a
 * formula (`"=1+1"` still evaluates after unquoting). OWASP's CSV-injection
 * guidance concedes no producer-side encoding is safe for every consumer, so
 * the pasting spreadsheet is the enforcement point; cell bytes ship verbatim.
 */
function encodeTsvField(value: string): string {
  if (!/["\t\n]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Build an object that matches PM's expected `clipboardSerializer` shape.
 *
 * PM only calls `serializeFragment` on this object — it never touches the
 * other DOMSerializer methods. We read the schema off the fragment's
 * first child's type at call time.
 */
/**
 * Subclass `DOMSerializer` so the return value satisfies PM's
 * `clipboardSerializer?: DOMSerializer` type. PM only calls
 * `serializeFragment`; the `nodes` / `marks` tables are unused. We pass
 * empty stubs to the parent constructor and override serializeFragment.
 *
 * The walker path requires a live `EditorView` to call `view.nodeDOM(pos)`
 * + `getComputedStyle(el)`. The view is attached lazily after
 * `editor.on('create')` fires; pre-attach calls fall through to the
 * markdown→HTML pipeline.
 */
class MdastClipboardSerializer extends DOMSerializer {
  private readonly mdManager: MarkdownManager;
  private view: EditorView | null = null;

  constructor(mdManager: MarkdownManager) {
    super({}, {});
    this.mdManager = mdManager;
  }

  setView(view: EditorView): void {
    this.view = view;
  }

  override serializeFragment(
    fragment: Fragment,
    _options?: { document?: Document },
    target?: HTMLElement | DocumentFragment,
  ): HTMLElement | DocumentFragment {
    const view = this.view;
    // Table-cell selection escape hatch. The walker's containment guard
    // (see `clipboard-walker.ts` `selectionPartiallyCoversTopLevelNode`)
    // bails on any selection that only partially covers a top-level
    // block — and a `CellSelection` is by definition inside the top-
    // level `<table>`, so the walker always returns empty for it.
    // Falling through to the markdown tier is worse: `sliceToDocJson`
    // can't fit tableRow / tableCell fragments as top-level doc content,
    // so markdown output is empty and the `text/html` clipboard payload
    // collapses to `""`. Paste-side (any target — our own, GitHub,
    // Sheets) then reads only `text/plain` and the entire multi-cell
    // selection lands in one cell.
    //
    // For CellSelection, use the schema's default DOMSerializer directly
    // on the fragment. The fragment already carries `table` + `tableRow`
    // + `tableCell` structure from `CellSelection.content()`, so
    // `serializeFragment` produces standard `<table><tr><td>...` HTML
    // that every paste handler understands.
    if (view && view.state.selection instanceof CellSelection) {
      try {
        const schema = fragment.firstChild?.type.schema ?? view.state.schema;
        const defaultSerializer = DOMSerializer.fromSchema(schema);
        // The default DOMSerializer would render comment spans (hidden but
        // byte-carrying) into the cell payload — scrub before serializing.
        const wrapped = wrapAsTableFragment(
          stripClipboardOmittedFromFragment(fragment, schema),
          schema,
        );
        return defaultSerializer.serializeFragment(wrapped, { document }, target);
      } catch (err) {
        logSerializeFail({
          view: 'wysiwyg',
          kind: 'html',
          reason: `cellselection:${(err as Error)?.message ?? 'unknown'}`,
        });
        // Fall through to the standard tiers below.
      }
    }
    // Walker tier (primary). When a view is attached AND there's an active
    // selection, capture whatever React rendered + whatever CSS resolved.
    // A walker throw or empty result falls through to the markdown tier
    // below — distinct try block so operators can distinguish walker bugs
    // from markdown-pipeline bugs.
    if (view && view.state.selection.from !== view.state.selection.to) {
      try {
        const slice = view.state.selection.content();
        const env = buildWalkerEnv(view, this.mdManager);
        const walked = walkLiveDomToInlineStyledFragment(slice, view, env);
        if (walked.childNodes.length > 0) {
          if (target) {
            for (const child of Array.from(walked.childNodes)) target.appendChild(child);
            return target;
          }
          return walked;
        }
      } catch (err) {
        logSerializeFail({
          view: 'wysiwyg',
          kind: 'html',
          reason: `walker:${(err as Error)?.message ?? 'unknown'}`,
        });
      }
    }
    // Markdown tier (fallback). Used when no view is attached, the selection
    // is empty (e.g. drag-out), the walker yields an empty fragment, or the
    // walker tier threw above.
    try {
      const schema = fragment.firstChild?.type.schema;
      if (!schema) return target ?? document.createDocumentFragment();
      // The `fragment` PM hands us has already been context-unwrapped: the
      // slice's open depths are gone, so a partially-covered ancestor that
      // survived PM's own unwrap loop (single-level textblocks like heading /
      // codeBlock, or multi-child interiors like a two-paragraph blockquote
      // span) would serialize its full block element into the rich payload.
      // Re-derive the ORIGINAL slice from the live selection — where the open
      // depths still exist — and peel partially-covered wrappers before
      // serializing. `data-pm-slice` is unaffected: PM stamps it from the
      // original slice AFTER this method returns, so the OK→OK paste path
      // (text/html + data-pm-slice) keeps its metadata.
      let slice = new SliceCtor(fragment, 0, 0);
      if (view && view.state.selection instanceof TextSelection && !view.state.selection.empty) {
        try {
          slice = stripEnclosingMarkerWrappers(view.state.selection.content(), view.state);
        } catch (err) {
          logSerializeFail({
            view: 'wysiwyg',
            kind: 'html',
            reason: `interior:${(err as Error)?.message ?? 'unknown'}`,
          });
          slice = new SliceCtor(fragment, 0, 0);
        }
      }
      // Same omission semantics as the walker tier: the markdown tier is an
      // external-facing text/html payload, so clipboard-omitted content is
      // scrubbed before serialization.
      const html = markdownToHtml(
        sliceToMarkdown(stripClipboardOmitted(slice, schema), schema, this.mdManager),
      );
      const frag = parseHtmlToDocumentFragment(html);
      if (target) {
        for (const child of Array.from(frag.childNodes)) target.appendChild(child);
        return target;
      }
      return frag;
    } catch (err) {
      logSerializeFail({
        view: 'wysiwyg',
        kind: 'html',
        reason: `markdown:${(err as Error)?.message ?? 'unknown'}`,
      });
      return target ?? document.createDocumentFragment();
    }
  }
}

export function createClipboardHtmlSerializer(
  deps: WysiwygSerializerDeps,
): ClipboardHtmlSerializerHandle {
  const serializer = new MdastClipboardSerializer(deps.mdManager);
  return {
    serializer,
    setView: (view) => serializer.setView(view),
  };
}

function sliceToMarkdown(slice: Slice, schema: Schema, mdManager: MarkdownManager): string {
  return mdManager.serialize(sliceToDocJson(slice, schema));
}

/**
 * For a descriptor-rendered URL-bearing leaf (e.g. `<img>` inside
 * `CommonMarkImage`'s NodeView, deeply wrapped in react-medium-image-zoom
 * spans + a `[data-node-view-wrapper]` div + an outer `.react-renderer`
 * div), find the descriptor's outermost DOM root so we can resolve its PM
 * position.
 *
 * Without this lookup, the walker calls `posAtDOM(<img>, 0)` and PM's
 * walking-up logic returns a position INSIDE the descriptor's content
 * area. For an atom node like `JsxComponent`, that area is opaque to PM,
 * `nodeAt(pos)` returns null, and the walker emits `serializer-null` —
 * cross-app source-fallback for relative-URL
 * images silently no-ops.
 *
 * Strategy: walk up from `live` to the outermost `.react-renderer` /
 * `[data-node-view-wrapper]` / `[data-jsx-component]` ancestor — that
 * element is what PM tracks as the descriptor's DOM root. Returns `null`
 * when no descriptor wrapper exists between `live` and the editor root
 * (covers the inline `<a>` mark case — that text is raw PM content, not
 * a NodeView).
 *
 * Wrappers carrying `data-clipboard-inline-leaf` opt OUT of descriptor
 * detection: the wrapper exists for live-editor render concerns (e.g.,
 * `ImageInlineZoom` wraps inline `<img>` in `react-medium-image-zoom`'s
 * `<Zoom>` for click-to-enlarge) but the PM node it surrounds is a bare
 * inline atom — not a descriptor. Routing those through the descriptor-
 * parent codepath (`posAtDOM(<p>, idx, -1)`) would push position
 * resolution through paragraph child-indexing, which has different
 * mark-interaction semantics than the direct `posAtDOM(<img>, 0)` path
 * the bare PM image node uses. Skipping these wrappers preserves
 * the direct-leaf clipboard behavior while still mounting the Zoom UI.
 *
 * Exported only for unit-test reach; the production caller is
 * `buildWalkerEnv` below.
 */
export function findDescriptorRoot(live: Element): Element | null {
  let descriptorRoot: Element | null = null;
  let cur: Element | null = live;
  while (cur && !cur.classList.contains('ProseMirror')) {
    // Opt-out: live-editor render wrappers around bare inline PM atoms
    // (e.g., `ImageInlineZoom`'s `<Zoom>` wrap). The PM node IS the leaf
    // `<img>` — there is no descriptor here, even though tiptap stamps
    // `data-node-view-wrapper` on the NodeViewWrapper. Skip these so
    // `posAtDOM(<img>, 0)` stays the resolution path.
    if (cur.hasAttribute('data-clipboard-inline-leaf')) {
      cur = cur.parentElement;
      continue;
    }
    if (
      cur.classList.contains('react-renderer') ||
      cur.hasAttribute('data-node-view-wrapper') ||
      cur.hasAttribute('data-jsx-component')
    ) {
      // Keep climbing — for nested descriptors, the OUTERMOST is the one
      // PM positions in its parent's content. For example, `CommonMarkImage`
      // is a `JsxComponent` rendered as `.react-renderer.node-jsxComponent`
      // wrapping `[data-node-view-wrapper data-jsx-component]`.
      descriptorRoot = cur;
    }
    cur = cur.parentElement;
  }
  return descriptorRoot;
}

/**
 * Construct the walker env for a live editor view. The
 * `serializeElementMarkdown` closure resolves a live DOM element to its
 * PM range and serializes via `mdManager.serialize` — the single
 * canonical pipeline used by every OK markdown emission path; the
 * URL-portability source-fallback emission path reuses it for byte
 * parity with copy text/plain.
 *
 * Returns a {@link SerializeResult} discriminated union so operators can
 * triage outcomes downstream:
 *   - `{ kind: 'no-correspondence' }` when the live element has no PM
 *     correspondence (`view.posAtDOM` returned -1 or
 *     `view.state.doc.nodeAt(pos)` returned null because the PM doc is
 *     inconsistent with the live DOM). The walker emits
 *     `phase: 'serializer-null'` (no errorClass — there was no throw).
 *   - `{ kind: 'failed', errorClass }` when a step in the chain threw —
 *     either `view.posAtDOM` (RangeError when the live element is
 *     detached / not inside the editor) or `mdManager.serialize`
 *     (corrupted slice, markdown-pipeline regression). The walker
 *     emits `phase: 'serializer-throw'` with the classified error
 *     name so dashboards can distinguish a markdown-pipeline
 *     regression (content-loss class) from baseline detach noise.
 *   - `{ kind: 'ok', markdown }` on success.
 *
 * The slice is `[pos, pos + node.nodeSize)`. For an inline atom (`<img>`)
 * inside a paragraph, this is the atom's 1-position range; for marked
 * text wrapped by an `<a>` element, `nodeAt(pos)` returns the text node
 * and `nodeSize` is the text length — the resulting slice covers the
 * marked text run, and serialization round-trips through any nested
 * `<strong>` / `<em>` / etc. marks because `mdManager.serialize` already
 * handles nested formatting.
 */
function buildWalkerEnv(view: EditorView, mdManager: MarkdownManager): WalkerEnv {
  return {
    getComputedStyle: (el) => window.getComputedStyle(el),
    serializeElementMarkdown: (live): SerializeResult => {
      // For descriptor-rendered leaves (e.g. `<img>` inside CommonMarkImage's
      // NodeView), correlate via the descriptor's parent + child-index so
      // PM returns the position OF the descriptor, not a position inside
      // its opaque content area. `posAtDOM(descriptor, 0)` returns the
      // INSIDE position which `nodeAt` resolves to null for atom descriptors.
      const descriptorRoot = findDescriptorRoot(live);
      let pos: number;
      try {
        const parent = descriptorRoot?.parentElement;
        if (parent && descriptorRoot) {
          const idx = Array.from(parent.children).indexOf(descriptorRoot);
          pos = view.posAtDOM(parent, idx, -1);
        } else {
          pos = view.posAtDOM(live, 0);
        }
      } catch (err) {
        return { kind: 'failed', errorClass: classifyError(err) };
      }
      if (pos < 0) return { kind: 'no-correspondence' };
      const node = view.state.doc.nodeAt(pos);
      if (!node) return { kind: 'no-correspondence' };
      const slice = view.state.doc.slice(pos, pos + node.nodeSize);
      try {
        return { kind: 'ok', markdown: sliceToMarkdown(slice, view.state.schema, mdManager) };
      } catch (err) {
        return { kind: 'failed', errorClass: classifyError(err) };
      }
    },
  };
}

// Note on the markdown tier's html shape: no wrapper element is added. PM's
// `serializeForClipboard` attaches `data-pm-slice` to our first returned
// element with the correctly computed `openStart openEnd context` value;
// wrapping in a `<div>` would only add noise in destinations that preserve
// attributes verbatim (e.g. GitHub's comment textarea) — PM's paste-side
// detection uses `querySelector("[data-pm-slice]")`, which finds the
// attribute on any element.

/**
 * Wrap a slice's content in a synthetic `doc` node. MarkdownManager.serialize
 * expects a PM doc JSON; this synthesizes one from an arbitrary slice.
 *
 * Slice open-depth info (openStart/openEnd) is discarded here — markdown
 * serialization has no concept of it, and discarding promotes every
 * partially-covered ancestor into a complete block. That is only safe because
 * the clipboard call sites peel partially-covered marker-bearing wrappers via
 * `stripEnclosingMarkerWrappers` BEFORE reaching this function; closed slices
 * and whole-node doc slices (the walker's source-fallback) are unaffected by
 * the discard.
 *
 * Production callers: `sliceToMarkdown` above and the copy/cut intercept
 * (`handle-copy.ts`), which serializes the unscrubbed slice for the
 * private OK clipboard flavor.
 */
export function sliceToDocJson(slice: Slice, schema: Schema): JSONContent {
  let content = slice.content;
  // If the slice content starts with an inline node (e.g., an inline image
  // atom from `<p>prose <img> more</p>`), the doc schema rejects placing
  // it directly under the document — top-level content must be blocks.
  // Wrap in a paragraph so `createAndFill` succeeds and the inline atom
  // round-trips through `mdManager.serialize` as `![alt](src)` instead of
  // an empty string.
  const first = content.firstChild;
  if (first?.isInline) {
    const paragraph = schema.nodes.paragraph;
    if (paragraph) {
      const wrapped = paragraph.createAndFill(null, content);
      if (wrapped) content = Fragment.from(wrapped);
    }
  }
  let docNode = schema.topNodeType.createAndFill(null, content);
  if (!docNode) {
    // Some stripped slices reduce to a fragment whose children cannot sit
    // directly under the document — most commonly bare `listItem`s left when
    // `stripEnclosingMarkerWrappers` peels a `list` off a selection that spans
    // the interior of two or more items. Filling fails, and the caller would
    // otherwise ship an empty clipboard string, silently dropping the copied
    // text. Lift those children to their own block content (item → paragraph)
    // and retry, so the interior text survives without the list markers —
    // matching the two-paragraph blockquote-span result.
    const lifted = liftUnfittableChildren(content, schema);
    if (lifted !== content) docNode = schema.topNodeType.createAndFill(null, lifted);
  }
  if (!docNode) {
    const empty = schema.topNodeType.createAndFill();
    if (!empty) throw new Error('[clipboard] schema cannot fill topNodeType');
    return empty.toJSON() as JSONContent;
  }
  return docNode.toJSON() as JSONContent;
}

/**
 * Replace any child the document's top node cannot hold directly with its own
 * block content. A bare `listItem` (schema `content: paragraph+ block*`) is not
 * valid top-level doc content, so a fragment of them fails `createAndFill`; this
 * lifts each to the paragraphs/blocks it wraps. One pass is enough for the
 * clipboard shapes that reach here (list interiors); the caller retries the fill
 * and still falls back to an empty doc if the lift did not help.
 */
function liftUnfittableChildren(content: Fragment, schema: Schema): Fragment {
  const match = schema.topNodeType.contentMatch;
  const out: Node[] = [];
  let changed = false;
  content.forEach((child) => {
    if (!match.matchType(child.type) && child.childCount > 0) {
      child.content.forEach((grandchild) => {
        out.push(grandchild);
      });
      changed = true;
    } else {
      out.push(child);
    }
  });
  return changed ? Fragment.fromArray(out) : content;
}

/**
 * Ensure a fragment for a `CellSelection` is wrapped in a `<table>` node.
 *
 * `CellSelection.content()` returns different shapes depending on the
 * selection:
 *   - Cells across multiple rows or spanning the whole row →
 *     `Fragment<table>` where the top-level child is the `table` node
 *     containing the selected `tableRow` children.
 *   - Cells within a single row → `Fragment<tableRow>` (cells wrapped in
 *     a row but NOT in a table).
 *   - A single cell → `Fragment<tableCell>` (bare cell).
 *
 * The default DOMSerializer needs the outer `<table>` element for the
 * paste-side to recognize the shape as a table, so we normalize every
 * incoming fragment to `Fragment<table>` before serializing. Uses the
 * schema's node types so it works with any table-flavored schema
 * (GFM tables, custom extensions).
 */
export function wrapAsTableFragment(fragment: Fragment, schema: Schema): Fragment {
  const tableType = schema.nodes.table;
  const rowType = schema.nodes.tableRow;
  if (!tableType || !rowType) return fragment;
  const first = fragment.firstChild;
  if (!first) return fragment;
  if (first.type === tableType) return fragment;
  const rows: Node[] = [];
  fragment.forEach((child) => {
    if (child.type === rowType) {
      rows.push(child);
    } else {
      const row = rowType.createAndFill(null, child);
      if (row) rows.push(row);
    }
  });
  const table = tableType.createAndFill(null, Fragment.fromArray(rows));
  return table ? Fragment.from(table) : fragment;
}

function parseHtmlToDocumentFragment(html: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const frag = document.createDocumentFragment();
  for (const child of Array.from(doc.body.childNodes)) {
    frag.appendChild(child);
  }
  return frag;
}
