/**
 * App-specific shared extensions — uses core's sharedExtensions but swaps
 * JsxComponent for the React-enabled version with NodeView, and adds
 * app-only extensions (slash command menu, etc.).
 */
import { sharedExtensions as coreExtensions } from '@inkeep/open-knowledge-core';
import { Extension } from '@tiptap/core';
import FileHandler from '@tiptap/extension-file-handler';
import { KeyboardNav } from '../block-ux/keyboard-nav';
import { TiptapFindReplace } from '../find-replace/tiptap-find-replace-extension';
import { uploadAndInsert } from '../image-upload/index.ts';
import { getComponentItems, getInlineComponentItems } from '../slash-command/component-items';
import { getEmbedStarterItems } from '../slash-command/embed-starter-items';
import { getSlashCommandItems } from '../slash-command/items';
import { BlockMover } from './block-mover';
// BridgeIdPlugin — SelectionStatePlugin consumes it to resolve stable
// ancestor-chain IDs across PM re-renders (see Precedent "Selection state
// as typed PM PluginState"). Plugin falls back to pos-derived synthetic
// IDs if absent (unit-test path); production wants the real
// Y.XmlElement-keyed IDs. bridge-id-plugin lives on as a standalone
// stable-identity primitive.
import { BridgeIdPlugin } from './bridge-id-plugin';
import { chunkWrapperDecorationPlugin } from './chunk-wrapper-decoration';
import { CodeBlockFidelity } from './code-block';
import { BlockDragHandle } from './drag-handle';
import { FootnoteAnchorScroll } from './footnote-anchor-scroll';
import { FormattingShortcuts } from './formatting-shortcuts';
import { HeadingAnchors } from './heading-anchors';
import { ImageInlineZoom } from './image-inline-zoom';
import { InternalLink } from './internal-link';
import { JsxComponent } from './jsx-component';
import { MathInline } from './math-inline';
import { RawMdxFallback } from './raw-mdx-fallback';
import { SelectionStatePlugin } from './selection-state-plugin';
import { SlashCommand } from './slash-command';
import { SourceDirtyObserver } from './source-dirty-observer';
import { TabFocusTrap } from './tab-focus-trap';
import { TableInsertControls } from './table-insert-controls';
import { TagClickPlugin } from './tag-click-plugin';
import { Tag } from './tag-view';
import { WikiLink } from './wiki-link';
import { WikiLinkEmbed } from './wiki-link-embed';

// Replace core extensions that have app-side NodeViews or mark views.
export const sharedExtensions = [
  ...coreExtensions.map((ext) => {
    if (ext.name === 'jsxComponent') return JsxComponent;
    // Spread core's options so any future `ImageSrcFidelity.configure({
    // ... })` addition in `core/src/extensions/shared.ts` flows through
    // the `.extend()` boundary unchanged. The explicit `inline: true`
    // re-assert is defensive — `.extend()` already drops core's
    // instance-scoped configure(), and the PM image group depends on
    // it. Casting `ext.options` to `Record<string, unknown>` because the
    // narrowed `coreExtensions` element type is the union of every
    // extension's options, which `.configure()` doesn't usefully type.
    if (ext.name === 'image') {
      const coreOptions = (ext as unknown as { options?: Record<string, unknown> }).options ?? {};
      return ImageInlineZoom.configure({ ...coreOptions, inline: true });
    }
    if (ext.name === 'rawMdxFallback') return RawMdxFallback;
    if (ext.name === 'wikiLink') return WikiLink;
    if (ext.name === 'wikiLinkEmbed') return WikiLinkEmbed;
    if (ext.name === 'link') return InternalLink;
    if (ext.name === 'mathInline') return MathInline;
    if (ext.name === 'tag') return Tag;
    if (ext.name === 'codeBlock') return CodeBlockFidelity;
    return ext;
  }),
  SlashCommand.configure({
    itemsSources: [
      getSlashCommandItems,
      getComponentItems,
      // Themed `html preview` embed starters (chart, stat cards, custom SVG,
      // interactive control) — the human on-ramp for the embed palette.
      getEmbedStarterItems,
      // Inline-atom slash entries (Tag — placeholder pill with inline
      // input; future inline atoms like mathInline can extend this
      // list). Kept separate from `getComponentItems` because inline
      // atoms aren't in the descriptor registry — they map to direct
      // PM nodes via the `mdxJsxTextElement` short-circuit in
      // `markdown/index.ts`.
      getInlineComponentItems,
    ],
    categoryLabels: {
      content: 'Components',
      layout: 'Layout',
      media: 'Media',
      data: 'Data',
      embed: 'Embeds',
    },
  }),
  FormattingShortcuts,
  // TabFocusTrap — fall-through Tab / Shift-Tab handler. Runs LAST in the
  // keymap chain (priority 1) so ListItem (100, sink/lift), Table (60, next
  // cell), and the suggestion plugins all get first crack. Without this,
  // Tab inside plain text falls through to browser-default focus traversal,
  // moving keyboard focus OUT of the editor. Pair with KeyboardNav's Escape
  // handler for the keyboard exit (WCAG 2.1.2 "No Keyboard Trap").
  TabFocusTrap,
  // Omit `allowedMimeTypes` so the FileHandler accepts every browser-
  // readable file type. The server is the single policy point — there's
  // no user-facing cap either; disk fullness (`storage-full` → 507) is
  // the only rejection axis, and the SVG `<img>`-only routing happens
  // server-side.
  FileHandler.configure({
    onDrop(editor, files, pos) {
      for (const file of files) {
        uploadAndInsert(file, editor, pos);
      }
    },
    onPaste(editor, files, _html) {
      for (const file of files) {
        uploadAndInsert(file, editor, editor.state.selection.from);
      }
    },
  }),
  HeadingAnchors,
  TiptapFindReplace,
  // TagClickPlugin — intercepts clicks on `<a class="tag">` chips and
  // dispatches a custom DOM event so the host app can mount a TagDialog
  // listener at app scope. Independent of `link` / `wikiLink` chip plugins
  // because tags don't share their PropPanel surface or PM mark identity.
  TagClickPlugin,
  // FootnoteAnchorScroll — intercept clicks on `<a href="#fn-{id}">` inside
  // the editor and scroll to the matching `<aside id="fn-{id}">` instead
  // of letting the browser set `location.hash` (which collides with the
  // SPA's `#/<docName>` routing).
  FootnoteAnchorScroll,
  // BlockDragHandle — drag grip + "+" button in the left margin on block hover.
  // Registers DragHandlePlugin imperatively (bare DOM container, NOT a React
  // component) so Activity mode flips don't trigger React's removeChild
  // reconciliation error. The `lockDragHandle` / `unlockDragHandle` commands
  // that other surfaces (PropPanel, slash menu) used to get from the stock
  // `DragHandle.extend({...})` are still available — `DragHandlePlugin`
  // registers them as part of the plugin.
  BlockDragHandle,
  BlockMover,
  // TableInsertControls — Notion-style "+" bars on the right/bottom table
  // edges (hover-reveal, append column/row). Imperative DOM mounted on
  // `view.dom.parentElement` for the same Activity-flip reason as
  // BlockDragHandle; keyboard parity lives in the TableCellHandles dropdowns.
  TableInsertControls,
  SourceDirtyObserver,
  KeyboardNav,
  // Selection layer — must come after BridgeIdPlugin so ancestor-chain
  // lookups resolve stable IDs. Order is load-bearing only wrt BridgeId;
  // KeyboardNav is orthogonal.
  // Placeholder moved to TiptapEditor.tsx (new-doc affordances)
  // so it can be configured per-editor-instance with context-aware text.
  BridgeIdPlugin,
  SelectionStatePlugin,
  // Block-chunked content-visibility:auto. Applies the
  // `ok-chunk-wrapper` class to every top-level direct child of the doc
  // via PM Decoration.node. Off-viewport blocks skip layout/paint per the
  // CSS rule at `globals.css:.ProseMirror .ok-chunk-wrapper`. No state,
  // no documentName keying — safe to register universally.
  Extension.create({
    name: 'chunkWrapperDecoration',
    addProseMirrorPlugins() {
      return [chunkWrapperDecorationPlugin()];
    },
  }),
];
