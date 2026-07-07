/**
 * Shared extension list used by the editor, persistence layer, and round-trip tests.
 * Single source of truth — drift between these causes silent data corruption.
 */
import Highlight from '@tiptap/extension-highlight';
import { TableRow } from '@tiptap/extension-table';
import StarterKit from '@tiptap/starter-kit';
import { BlockquoteFidelity } from './blockquote-fidelity.ts';
import { CodeBlockFidelity } from './code-block-fidelity.ts';
import { CodeMarkFidelity } from './code-mark-fidelity.ts';
import { CommentBlock } from './comment-block.ts';
import { CommentMark } from './comment-mark.ts';
import { DocFidelity } from './doc-fidelity.ts';
import { EmphasisFidelity, StrongFidelity } from './emphasis-fidelity.ts';
import { EscapeMark } from './escape-mark.ts';
import { FootnoteDefinition } from './footnote-definition.ts';
import { FootnoteReference } from './footnote-reference.ts';
import { HardBreakFidelity } from './hard-break-fidelity.ts';
import { HeadingFidelity } from './heading-fidelity.ts';
import { HtmlBlockFidelity } from './html-block-fidelity.ts';
import { ImageReferenceFidelity } from './image-reference-fidelity.ts';
import { ImageSrcFidelity } from './image-src-fidelity.ts';
import { JsxComponent } from './jsx-component.ts';
import { JsxInline } from './jsx-inline.ts';
import { LinkFidelity } from './link-fidelity.ts';
import { LinkRefDefFidelity } from './link-ref-def-fidelity.ts';
import { List, ListItem } from './list.ts';
import { MathInline } from './math-inline.ts';
import { RawMdxFallback } from './raw-mdx-fallback.ts';
import { SourceLiteralMark } from './source-literal-mark.ts';
import { StrikeFidelity } from './strike-fidelity.ts';
import { TableCellFidelity, TableFidelity, TableHeaderFidelity } from './table-fidelity.ts';
import { Tag } from './tag.ts';
import { ThematicBreakFidelity } from './thematic-break-fidelity.ts';
import { WikiLink } from './wiki-link.ts';
import { WikiLinkEmbed } from './wiki-link-embed.ts';

export const sharedExtensions = [
  // JsxComponent MUST be before StarterKit so its schema is registered.
  JsxComponent,
  // rawMdxFallback holds raw source for blocks that fail to parse.
  RawMdxFallback,
  // jsxInline — inline MDX like <Icon />.
  JsxInline,
  // mathInline — PM atom node for `$$x$$` mid-paragraph and `<InlineMath />`.
  // jsxInline remains the generic inline-MDX target.
  MathInline,
  // WikiLink also needs to register before StarterKit.
  WikiLink,
  // WikiLinkEmbed sits next to WikiLink — same priority ordering concern.
  WikiLinkEmbed,
  // Tag — `#tagname` inline atom (Obsidian parity). Sister to WikiLink:
  // also a custom inline atom that registers a parseHTML-friendly element
  // (`<a data-tag>`), needs schema priority over the StarterKit Link.
  Tag,
  // Unified list extension — single list+listItem NodeSpec (replaces the
  // BulletList/OrderedList/ListItem/TaskList/TaskItem fragmentation).
  List,
  ListItem,
  // Fidelity overrides: StarterKit built-ins are disabled (e.g. bold: false)
  // so these extensions are the active definitions, not overrides. Mark
  // names are mdast-canonical (`strong`/`emphasis`); StarterKit disable keys
  // stay as 'bold'/'italic' because those are TipTap extension keys, not
  // schema names.
  EmphasisFidelity,
  StrongFidelity,
  // StrikeFidelity carries `sourceDelimiter` ('~' vs '~~') so GFM
  // single-tilde strikethrough round-trips byte-equal; replaces the
  // StarterKit Strike.
  StrikeFidelity,
  // Override @tiptap/extension-code's `excludes: '_'` so the Code mark can
  // coexist with emphasis/strong on the same span. CommonMark allows it;
  // the upstream exclusion broke round-trip for `*a \`*\`*` and `_a \`_\`_`
  // inputs.
  CodeMarkFidelity,
  CodeBlockFidelity,
  // BlockquoteFidelity wraps Blockquote with `sourceMarkerSpacings` per-line:
  // captures `> foo` vs `>foo` form per source line so the to-markdown
  // handler emits each line with the user's chosen marker form.
  BlockquoteFidelity,
  HeadingFidelity,
  // ThematicBreak — mdast-canonical name (not horizontalRule).
  ThematicBreakFidelity,
  LinkFidelity,
  HtmlBlockFidelity,
  LinkRefDefFidelity,
  HardBreakFidelity,
  // escapeMark for structurally-ambiguous backslash escapes
  EscapeMark,
  // Doc-level `sourceDocBoundary` attr: document-boundary bytes (head BOM,
  // leading/trailing blanks, inter-block blank-line counts) captured at
  // parse time so the programmatic parse→PM→serialize round-trip is
  // byte-exact. The Y fragment never carries doc attrs, so the CRDT path
  // is unaffected by construction.
  DocFidelity,
  // Verbatim source text for unsupported inline markdown constructs.
  SourceLiteralMark,
  StarterKit.configure({
    undoRedo: false,
    bulletList: false,
    orderedList: false,
    listItem: false,
    // StarterKit's ListKeymap drives GFM-correct Backspace/Delete in lists
    // (join into previous item, lift out, merge a trailing paragraph back into
    // the list). Its default wrapperNames are ['bulletList','orderedList'] —
    // neither exists here, since the unified List extension names the wrapper
    // `list`. Without the correct name handleBackspace's hasListBefore check
    // never matches and PM's default joinBackward spawns a stray empty bullet.
    listKeymap: {
      listTypes: [{ itemName: 'listItem', wrapperNames: ['list'] }],
    },
    italic: false,
    bold: false,
    strike: false,
    code: false,
    codeBlock: false,
    heading: false,
    horizontalRule: false,
    hardBreak: false,
    link: false,
    blockquote: false,
    dropcursor: {
      color: 'color-mix(in oklch, var(--primary) 50%, transparent)',
      width: 2,
    },
  }),
  // TableFidelity wraps Table with a `sourceDashCounts` attr: the GFM
  // alignment-row dash counts captured at parse time and threaded back to
  // the to-markdown handler so `:---:` round-trips byte-equal.
  TableFidelity.configure({
    resizable: true,
  }),
  TableRow,
  // TableHeaderFidelity / TableCellFidelity carry per-cell `sourcePadding`
  // ({ left, right }) captured at parse time. The to-markdown table handler
  // re-emits the user's padding so hand-aligned tables round-trip byte-equal.
  TableHeaderFidelity,
  TableCellFidelity,
  // ImageSrcFidelity wraps Image with a `sourceUrl` attr (the original
  // doc-relative markdown URL) so the rendered `src` can be normalized to a
  // server-absolute / desktop-origin form while PM→mdast round-trips byte-
  // identical; its `renderHTML` applies the desktop-origin rewrite for inline
  // images (which render through TipTap's NodeView, not the React Image.tsx).
  ImageSrcFidelity.configure({ inline: true }),
  // Inline atom that preserves `![alt][ref]` / `![ref][]` / `![ref]` shapes
  // so reference identity survives round-trip. Plain inline images
  // (`![alt](src)`) keep flowing through the `image` node above.
  ImageReferenceFidelity,
  Highlight,
  // Custom comment mark — literal authoring annotation. Recognises
  // `%%text%%` (Obsidian) and `<!-- text -->` (HTML comment) inline
  // forms. Renders with `display: none` + `data-clipboard-omit="true"`
  // so the text is invisible in WYSIWYG and dropped from cross-app
  // clipboard payloads. The PM mark carries `sourceForm` (`'percent' |
  // 'html'`); PM-mediated saves preserve the form the author typed.
  CommentMark,
  // Block counterpart — block-level literal authoring annotation.
  // Recognises `%%\n…\n%%` (Obsidian fence) and `<!-- … -->`
  // (single-paragraph HTML comment, including multi-child paragraphs
  // whose body contains inline markdown). Renders with `display: none`
  // + `data-clipboard-omit="true"`. PM node carries `sourceForm` +
  // `sourceLayout` attributes; saves preserve byte-stable round-trip.
  CommentBlock,
  // Footnote inline reference `[^id]` (atom) + block definition
  // `[^id]: body` (block). remark-gfm parses into mdast `footnoteReference`
  // / `footnoteDefinition` nodes; round-trip via remark-gfm's existing
  // stringify path. Footnote refs corrupted to literal
  // `"footnoteReference"` text via the inline-unknown fallback; defs
  // were silently dropped via the ignore-list. These extensions fix the
  // corruption.
  FootnoteReference,
  FootnoteDefinition,
];
