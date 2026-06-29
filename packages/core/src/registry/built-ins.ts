import type { Nodes as MdastNodes } from 'mdast';
import {
  ALLOWED_AUDIO_MIME_TYPES,
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_PDF_MIME_TYPES,
  ALLOWED_VIDEO_MIME_TYPES,
} from '../constants/upload.ts';
import { emitMdxJsx } from '../markdown/serialize-helpers.ts';
import { isLoomUrl } from '../utils/loom-embed.ts';
import { isVimeoUrl } from '../utils/vimeo-embed.ts';
import { parseYouTubeUrl } from '../utils/youtube-embed.ts';
import type { JsxComponentMeta, PropDef } from './types.ts';

const calloutProps: PropDef[] = [
  {
    name: 'type',
    type: 'enum',
    enumValues: [
      'note',
      'tip',
      'important',
      'warning',
      'caution',
      'abstract',
      'info',
      'todo',
      'success',
      'question',
      'failure',
      'danger',
      'bug',
      'example',
      'quote',
    ],
    defaultValue: 'note',
    required: false,
    description: 'Callout variant',
  },
  {
    name: 'title',
    type: 'string',
    required: false,
    description: 'Optional heading shown above the body',
  },
  {
    name: 'icon',
    type: 'string',
    required: false,
    advanced: true,
    description: 'Custom lucide icon override (e.g. `lucide:Lightbulb`)',
    iconPicker: true,
  },
  {
    name: 'color',
    type: 'string',
    required: false,
    advanced: true,
    description: 'Optional accent color override (hex — e.g. `#F05032`)',
    colorPicker: true,
  },
  {
    name: 'collapsible',
    type: 'boolean',
    required: false,
    defaultValue: false,
    advanced: true,
    description: 'Render as a foldable `<details>` (Obsidian `[!TYPE]+/-`)',
  },
  {
    name: 'defaultOpen',
    type: 'boolean',
    required: false,
    defaultValue: true,
    advanced: true,
    description: 'When collapsible, start in the open state',
    hideWhen: (values) => values.collapsible !== true,
  },
  {
    name: 'children',
    type: 'reactnode',
    required: true,
    description: 'Callout content',
  },
];

const htmlImgProps: PropDef[] = [
  {
    name: 'src',
    type: 'string',
    required: true,
    defaultValue: '',
    description: 'Image source URL',
    accept: ALLOWED_IMAGE_MIME_TYPES,
    autoFocus: true,
  },
  {
    name: 'alt',
    type: 'string',
    required: true,
    description: 'Alt text',
  },
  {
    name: 'width',
    type: 'number',
    required: false,
    advanced: true,
    description: 'Image width',
  },
  {
    name: 'height',
    type: 'number',
    required: false,
    advanced: true,
    description: 'Image height',
  },
  {
    name: 'srcset',
    type: 'string',
    required: false,
    advanced: true,
    description: 'Responsive image candidate set (e.g. "x.png 1x, y.png 2x")',
  },
  {
    name: 'sizes',
    type: 'string',
    required: false,
    advanced: true,
    description: 'Responsive image sizes hint paired with srcset',
  },
  {
    name: 'loading',
    type: 'enum',
    enumValues: ['eager', 'lazy'],
    defaultValue: 'lazy',
    required: false,
    advanced: true,
    omitOnDefault: true,
    description: 'Native img loading strategy (defaults to lazy)',
  },
  {
    name: 'title',
    type: 'string',
    required: false,
    advanced: true,
    description: 'Native HTML title attribute (tooltip)',
  },
  {
    name: 'decoding',
    type: 'enum',
    enumValues: ['sync', 'async', 'auto'],
    defaultValue: 'auto',
    required: false,
    advanced: true,
    omitOnDefault: true,
    description: 'Hint for how the browser should decode the image',
  },
  {
    name: 'fetchpriority',
    type: 'enum',
    enumValues: ['high', 'low', 'auto'],
    defaultValue: 'auto',
    required: false,
    advanced: true,
    omitOnDefault: true,
    description: 'Resource fetch priority hint',
  },
  {
    name: 'crossorigin',
    type: 'enum',
    enumValues: ['anonymous', 'use-credentials'],
    required: false,
    advanced: true,
    description: 'CORS mode for the image fetch',
  },
  {
    name: 'referrerpolicy',
    type: 'string',
    required: false,
    advanced: true,
    description: 'Referrer policy for the image fetch (HTML referrerpolicy values)',
  },
  {
    name: 'align',
    type: 'enum',
    enumValues: ['center', 'left', 'right'],
    defaultValue: 'center',
    required: false,
    omitOnDefault: true,
    description: 'Alignment within the column',
    hidden: true,
  },
];

const embedProps: PropDef[] = [
  {
    name: 'src',
    type: 'string',
    required: true,
    defaultValue: '',
    description: 'Embedded page URL (must start with http:// or https://)',
    autoFocus: true,
  },
  {
    name: 'title',
    type: 'string',
    required: false,
    description: 'Iframe title (accessible label for screen readers)',
  },
  {
    name: 'width',
    type: 'string',
    required: false,
    advanced: true,
    description: 'Embed width as a CSS length (e.g. "100%", "640px")',
    cssLengthInput: true,
  },
  {
    name: 'height',
    type: 'string',
    required: false,
    advanced: true,
    description: 'Embed height as a CSS length (e.g. "26rem", "480px")',
    cssLengthInput: true,
  },
  {
    name: 'align',
    type: 'enum',
    enumValues: ['center', 'left', 'right'],
    defaultValue: 'center',
    required: false,
    omitOnDefault: true,
    description: 'Alignment within the column',
    hidden: true,
  },
];

const htmlVideoProps: PropDef[] = [
  {
    name: 'src',
    type: 'string',
    required: true,
    defaultValue: '',
    description: 'Video source URL',
    accept: ALLOWED_VIDEO_MIME_TYPES,
    autoFocus: true,
  },
  {
    name: 'controls',
    type: 'boolean',
    required: false,
    defaultValue: true,
    advanced: true,
    omitOnDefault: true,
    description: 'Show native HTML5 video controls (defaults to true)',
    hideWhen: (values) =>
      typeof values.src === 'string' && (isVimeoUrl(values.src) || isLoomUrl(values.src)),
  },
  {
    name: 'autoplay',
    type: 'boolean',
    required: false,
    advanced: true,
    description: 'Begin playback as soon as possible (usually requires muted)',
  },
  {
    name: 'poster',
    type: 'string',
    required: false,
    advanced: true,
    description: 'Poster image URL shown before playback',
    accept: ALLOWED_IMAGE_MIME_TYPES,
    hideWhen: (values) =>
      typeof values.src === 'string' && (isVimeoUrl(values.src) || isLoomUrl(values.src)),
  },
  {
    name: 'width',
    type: 'number',
    required: false,
    advanced: true,
    description: 'Video width',
  },
  {
    name: 'height',
    type: 'number',
    required: false,
    advanced: true,
    description: 'Video height',
  },
  {
    name: 'title',
    type: 'string',
    required: false,
    advanced: true,
    description: 'Native HTML title attribute (tooltip)',
  },
  {
    name: 'muted',
    type: 'boolean',
    required: false,
    advanced: true,
    description: 'Mute audio on load',
  },
  {
    name: 'loop',
    type: 'boolean',
    required: false,
    advanced: true,
    description: 'Restart from the beginning when playback ends',
    hideWhen: (values) => typeof values.src === 'string' && isLoomUrl(values.src),
  },
  {
    name: 'playsinline',
    type: 'boolean',
    required: false,
    advanced: true,
    description: 'Play inline on iOS rather than entering fullscreen',
    hideWhen: (values) =>
      typeof values.src === 'string' && (isVimeoUrl(values.src) || isLoomUrl(values.src)),
  },
  {
    name: 'preload',
    type: 'enum',
    enumValues: ['none', 'metadata', 'auto'],
    required: false,
    advanced: true,
    description: 'Hint for how much of the video to preload',
    hideWhen: (values) =>
      typeof values.src === 'string' &&
      (parseYouTubeUrl(values.src) !== null || isVimeoUrl(values.src) || isLoomUrl(values.src)),
  },
  {
    name: 'align',
    type: 'enum',
    enumValues: ['center', 'left', 'right'],
    defaultValue: 'center',
    required: false,
    omitOnDefault: true,
    description: 'Alignment within the column',
    hidden: true,
  },
];

const htmlAudioProps: PropDef[] = [
  {
    name: 'src',
    type: 'string',
    required: true,
    defaultValue: '',
    description: 'Audio source URL',
    accept: ALLOWED_AUDIO_MIME_TYPES,
    autoFocus: true,
  },
  {
    name: 'controls',
    type: 'boolean',
    required: false,
    defaultValue: true,
    advanced: true,
    omitOnDefault: true,
    description: 'Show native HTML5 audio controls (defaults to true)',
  },
  {
    name: 'autoplay',
    type: 'boolean',
    required: false,
    advanced: true,
    description: 'Begin playback as soon as possible (usually requires muted)',
  },
  {
    name: 'title',
    type: 'string',
    required: false,
    advanced: true,
    description: 'Native HTML title attribute (tooltip)',
  },
  {
    name: 'muted',
    type: 'boolean',
    required: false,
    advanced: true,
    description: 'Mute audio on load',
  },
  {
    name: 'loop',
    type: 'boolean',
    required: false,
    advanced: true,
    description: 'Restart from the beginning when playback ends',
  },
  {
    name: 'preload',
    type: 'enum',
    enumValues: ['none', 'metadata', 'auto'],
    required: false,
    advanced: true,
    description: 'Hint for how much of the audio to preload',
  },
];

const accordionProps: PropDef[] = [
  {
    name: 'title',
    type: 'string',
    required: true,
    description: 'Accordion heading shown inside the <summary>',
  },
  {
    name: 'defaultOpen',
    type: 'boolean',
    required: false,
    defaultValue: false,
    description: 'When true, the accordion renders expanded on initial load',
  },
  {
    name: 'icon',
    type: 'string',
    required: false,
    advanced: true,
    description: 'Custom lucide icon override (e.g. `lucide:Rocket`)',
    iconPicker: true,
  },
  {
    name: 'description',
    type: 'string',
    required: false,
    advanced: true,
    description: 'Optional subtitle rendered below the title inside <summary>',
  },
  {
    name: 'id',
    type: 'string',
    required: false,
    advanced: true,
    description: 'HTML id attribute for deep-linking (e.g. `#advanced-options`)',
  },
  {
    name: 'name',
    type: 'string',
    required: false,
    advanced: true,
    description: 'HTML5 <details name=> group — siblings with the same name are mutually exclusive',
  },
];

const gfmCalloutProps: PropDef[] = [
  calloutProps[0],
  calloutProps[1],
  calloutProps[4],
  calloutProps[5],
  calloutProps[6],
];

const commonMarkImageProps: PropDef[] = [
  htmlImgProps[0], // src
  htmlImgProps[1], // alt
  htmlImgProps[7], // title (advanced via shared identity)
];

const htmlDetailsAccordionProps: PropDef[] = [
  accordionProps[0],
  accordionProps[1],
  accordionProps[4],
  accordionProps[5],
];

const wikiEmbedImageProps: PropDef[] = [
  {
    name: 'alias',
    type: 'string',
    required: false,
    defaultValue: '',
    description: 'Alt text (Obsidian alias syntax: `![[file.png|alt text]]`)',
  },
];

const wikiEmbedVideoProps: PropDef[] = [
  {
    name: 'alias',
    type: 'string',
    required: false,
    defaultValue: '',
    description: 'Title text (Obsidian alias syntax: `![[clip.mp4|title]]`)',
  },
];

const wikiEmbedAudioProps: PropDef[] = [
  {
    name: 'alias',
    type: 'string',
    required: false,
    defaultValue: '',
    description: 'Title text (Obsidian alias syntax: `![[song.mp3|title]]`)',
  },
];

const tabsProps: PropDef[] = [
  {
    name: 'id',
    type: 'string',
    required: false,
    advanced: true,
    description: 'HTML id attribute for deep-linking (e.g. `#install-tabs`)',
  },
];

const tabProps: PropDef[] = [
  {
    name: 'label',
    type: 'string',
    required: true,
    autoFocus: true,
    defaultValue: 'Tab',
    description: 'Tab strip label — shown in the clickable pill at the top',
  },
  {
    name: 'id',
    type: 'string',
    required: false,
    advanced: true,
    description: 'HTML id attribute for deep-linking (e.g. `#tab-npm`)',
  },
];

const mathProps: PropDef[] = [
  {
    name: 'formula',
    type: 'string',
    required: true,
    autoFocus: true,
    language: 'latex',
    description: 'LaTeX math source (rendered with KaTeX in the browser)',
  },
  {
    name: 'id',
    type: 'string',
    required: false,
    advanced: true,
    description: 'HTML id attribute for deep-linking (e.g. `#eq-pythagoras`)',
  },
  {
    name: 'language',
    type: 'string',
    required: false,
    advanced: true,
    description:
      'Forward-compat hint for the math source language (default `latex`). Reserved for future MathJax / Typst / AsciiMath substrates.',
  },
];
const dollarMathProps: PropDef[] = [mathProps[0]];
const mathFenceProps: PropDef[] = [mathProps[0]];
const mermaidProps: PropDef[] = [
  {
    name: 'chart',
    type: 'string',
    required: true,
    hidden: true,
    description:
      'Mermaid chart source (graph / flowchart / sequenceDiagram / class / state / etc.)',
  },
];

const wikiEmbedFileProps: PropDef[] = [
  {
    name: 'alias',
    type: 'string',
    required: false,
    defaultValue: '',
    description: 'Display name override (Obsidian alias syntax: `![[file.zip|label]]`)',
  },
];

const fileProps: PropDef[] = [
  {
    name: 'src',
    type: 'string',
    required: true,
    defaultValue: '',
    description: 'File URL',
    accept: ['*/*'],
    autoFocus: true,
  },
];

const pdfProps: PropDef[] = [
  {
    name: 'src',
    type: 'string',
    required: true,
    defaultValue: '',
    description: 'PDF source URL',
    accept: ALLOWED_PDF_MIME_TYPES,
    autoFocus: true,
  },
  {
    name: 'title',
    type: 'string',
    required: false,
    advanced: true,
    description: 'Accessible label for the embedded PDF viewer',
  },
  {
    name: 'anchor',
    type: 'string',
    required: false,
    advanced: true,
    description: 'PDF viewer parameters as a single URL-fragment string (e.g. `page=3&height=600`)',
  },
];

const mirrorProps: PropDef[] = [
  {
    name: 'src',
    type: 'string',
    required: true,
    description: 'Path of the source doc, extension-less (e.g. `api-spec`).',
    autoFocus: true,
  },
  {
    name: 'anchor',
    type: 'string',
    required: true,
    description: 'Id of the `<MirrorSource>` block within the source doc.',
  },
];

const mirrorSourceProps: PropDef[] = [
  {
    name: 'id',
    type: 'string',
    required: true,
    description:
      'Stable id agents and authors use to reference this block from `<Mirror>` elsewhere.',
    autoFocus: true,
  },
  {
    name: 'children',
    type: 'reactnode',
    required: true,
    description:
      'Block content this MirrorSource owns — paragraphs, callouts, code, nested JSX, anything.',
  },
];

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function serializeWikiEmbed(node: { attrs: { props?: unknown } }): MdastNodes {
  const p = node.attrs.props as
    | { target?: string; alias?: string | null; anchor?: string | null }
    | undefined;
  const target = p?.target ?? '';
  const alias = typeof p?.alias === 'string' && p.alias.length > 0 ? p.alias : null;
  const anchor = typeof p?.anchor === 'string' && p.anchor.length > 0 ? p.anchor : null;
  const label = alias ?? (anchor ? `${target}#${anchor}` : target);
  return {
    type: 'wikiLinkEmbed' as const,
    value: label,
    data: { target, anchor, alias },
    children: [{ type: 'text' as const, value: label }],
  } as unknown as MdastNodes;
}

export const builtInComponents: JsxComponentMeta[] = [
  {
    name: 'Callout',
    surface: 'canonical',
    hasChildren: true,
    props: calloutProps,
    icon: 'MessageSquareWarning',
    category: 'content',
    displayName: 'Callout',
    description:
      'Alert / admonition with 15 type variants — 5 GFM (note, tip, important, warning, caution) plus 10 Obsidian-parity (abstract, info, todo, success, question, failure, danger, bug, example, quote)',
    searchTerms: [
      'note',
      'tip',
      'important',
      'warning',
      'caution',
      'abstract',
      'info',
      'todo',
      'success',
      'question',
      'failure',
      'danger',
      'bug',
      'example',
      'quote',
      'alert',
      'admonition',
      'callout',
    ],
    serialize: (node, ctx) => emitMdxJsx('Callout', node, ctx, calloutProps),
  },

  {
    name: 'img',
    surface: 'canonical',
    hasChildren: false,
    isSelfClosing: true,
    props: htmlImgProps,
    icon: 'Image',
    category: 'media',
    displayName: 'Image',
    description: 'Image with click-to-zoom and HTML-native attributes',
    searchTerms: ['image', 'zoom', 'picture', 'photo'],
    placeholder: { label: 'Add an image' },
    serialize: (node, ctx) => emitMdxJsx('img', node, ctx, htmlImgProps),
  },
  {
    name: 'video',
    surface: 'canonical',
    hasChildren: false,
    isSelfClosing: true,
    props: htmlVideoProps,
    icon: 'SquarePlay',
    category: 'media',
    displayName: 'Video',
    description: 'HTML5 video player with native controls',
    searchTerms: ['video', 'media', 'player', 'mp4', 'webm', 'movie'],
    placeholder: { label: 'Add a video' },
    serialize: (node, ctx) => emitMdxJsx('video', node, ctx, htmlVideoProps),
  },
  {
    name: 'audio',
    surface: 'canonical',
    hasChildren: false,
    isSelfClosing: true,
    props: htmlAudioProps,
    icon: 'Volume2',
    category: 'media',
    displayName: 'Audio',
    description: 'HTML5 audio player with native controls',
    searchTerms: ['audio', 'sound', 'music', 'mp3', 'podcast', 'player'],
    placeholder: { label: 'Add audio' },
    serialize: (node, ctx) => emitMdxJsx('audio', node, ctx, htmlAudioProps),
  },
  {
    name: 'Pdf',
    surface: 'canonical',
    hasChildren: false,
    isSelfClosing: true,
    props: pdfProps,
    icon: 'FileText',
    category: 'media',
    displayName: 'PDF',
    description: 'Embedded PDF viewer (`#page=N` to open at page N, `#height=N` for viewer height)',
    searchTerms: ['pdf', 'document', 'embed', 'pdfjs'],
    placeholder: { label: 'Add a PDF' },
    serialize: (node, ctx) => emitMdxJsx('Pdf', node, ctx, pdfProps),
  },
  {
    name: 'File',
    surface: 'canonical',
    hasChildren: false,
    isSelfClosing: true,
    props: fileProps,
    icon: 'Paperclip',
    category: 'media',
    displayName: 'File',
    description: 'Downloadable file attachment — inline row with name + size + download link',
    searchTerms: ['file', 'attachment', 'download', 'document', 'zip', 'docx', 'doc'],
    placeholder: { label: 'Add a file' },
    serialize: (node, ctx) => emitMdxJsx('File', node, ctx, fileProps),
  },
  {
    name: 'Embed',
    surface: 'canonical',
    hasChildren: false,
    isSelfClosing: true,
    props: embedProps,
    icon: 'AppWindow',
    category: 'media',
    displayName: 'Embed',
    description:
      'Inline web embed (iframe) — drop a URL, get a resizable preview pane. For YouTube / Vimeo / Loom prefer `<video src="…">` (player props, click-facade); `<Embed>` auto-rewrites watch URLs as a fallback.',
    searchTerms: ['embed', 'iframe', 'website', 'page', 'inline', 'frame', 'preview'],
    placeholder: { label: 'Embed a URL' },
    serialize: (node, ctx) => emitMdxJsx('Embed', node, ctx, embedProps),
  },

  {
    name: 'Accordion',
    surface: 'canonical',
    hasChildren: true,
    props: accordionProps,
    icon: 'ChevronRight',
    category: 'content',
    displayName: 'Accordion',
    description:
      'Standalone expand/collapse via native HTML5 <details>/<summary>. Group siblings with the `name` prop for exclusive-accordion UX.',
    searchTerms: ['toggle', 'accordion', 'expandable', 'details', 'disclosure', 'collapse', 'fold'],
    exampleBody: 'Body content revealed when the accordion is expanded.',
    serialize: (node, ctx) => emitMdxJsx('Accordion', node, ctx, accordionProps),
  },
  {
    name: 'Tabs',
    surface: 'canonical',
    hasChildren: true,
    emptyChildName: 'Tab',
    props: tabsProps,
    icon: 'LayoutPanelTop',
    category: 'content',
    displayName: 'Tabs',
    description:
      'Horizontal tab strip + active panel below. Each `<Tab>` child is one panel; clickable pills at the top switch the active one. Active selection is ephemeral (resets on reload).',
    searchTerms: ['tabs', 'tabbed', 'panels', 'tabgroup', 'switcher'],
    exampleBody:
      '<Tab label="One">Body of the first tab panel.</Tab>\n  <Tab label="Two">Body of the second tab panel.</Tab>',
    serialize: (node, ctx) => emitMdxJsx('Tabs', node, ctx, tabsProps),
  },
  {
    name: 'Tab',
    surface: 'canonical',
    hasChildren: true,
    props: tabProps,
    icon: 'PanelTop',
    category: 'content',
    displayName: 'Tab',
    description:
      'A single tab panel inside a `<Tabs>` container — carries the strip label and the block-content body.',
    searchTerms: ['tab', 'panel'],
    exampleBody: 'Panel content — must be nested inside a `<Tabs>` parent.',
    serialize: (node, ctx) => emitMdxJsx('Tab', node, ctx, tabProps),
  },
  {
    name: 'Math',
    surface: 'canonical',
    hasChildren: false,
    isSelfClosing: true,
    props: mathProps,
    icon: 'Sigma',
    category: 'content',
    displayName: 'Math',
    description: 'Block math equation rendered with KaTeX from a LaTeX source string',
    searchTerms: ['math', 'latex', 'equation', 'formula', 'katex', 'tex'],
    serialize: (node, ctx) => emitMdxJsx('Math', node, ctx, mathProps),
  },
  {
    name: 'MermaidFence',
    surface: 'canonical',
    hasChildren: false,
    isSelfClosing: true,
    props: mermaidProps,
    icon: 'Workflow',
    category: 'content',
    displayName: 'Mermaid',
    description:
      'Diagram rendered from Mermaid source (flowchart, sequence, class, state, ER, gantt, pie). Authored exclusively as ` ```mermaid ` fenced code.',
    searchTerms: [
      'mermaid',
      'diagram',
      'flowchart',
      'graph',
      'sequence',
      'sequencediagram',
      'class',
      'state',
      'er',
      'erdiagram',
      'gantt',
      'pie',
      'chart',
    ],
    serialize: (node) => {
      const p = node.attrs.props as { chart?: string } | undefined;
      return {
        type: 'code' as const,
        lang: 'mermaid',
        meta: null,
        value: p?.chart ?? '',
      };
    },
  },
  {
    name: 'Mirror',
    surface: 'canonical',
    hasChildren: false,
    isSelfClosing: true,
    props: mirrorProps,
    icon: 'CopyPlus',
    category: 'content',
    displayName: 'Mirror',
    description:
      'Render a read-only copy of a `<MirrorSource>` block from another doc. Use to keep the same content in sync across multiple docs without copy-paste — edits land at the source, every Mirror reflects the change.',
    searchTerms: ['mirror', 'sync', 'synced', 'transclude', 'embed', 'reference', 'shared block'],
    serialize: (node, ctx) => emitMdxJsx('Mirror', node, ctx, mirrorProps),
  },
  {
    name: 'MirrorSource',
    surface: 'canonical',
    hasChildren: true,
    props: mirrorSourceProps,
    icon: 'GitBranch',
    category: 'content',
    displayName: 'Mirror Source',
    description:
      'Mark a block as the source of truth for content that appears in multiple docs. Wrap any block content; `<Mirror src="…" anchor="<id>">` references render this verbatim read-only at every call-site. Edit here, propagate everywhere.',
    searchTerms: ['mirror source', 'sync source', 'source block', 'master block', 'shared'],
    exampleBody:
      'Authoritative content lives inside this block — edits here propagate to every `<Mirror>` that references this id.',
    serialize: (node, ctx) => emitMdxJsx('MirrorSource', node, ctx, mirrorSourceProps),
  },

  {
    name: 'GFMCallout',
    surface: 'compat',
    hasChildren: true,
    props: gfmCalloutProps,
    icon: 'MessageSquareWarning',
    category: 'content',
    displayName: 'GFM Callout',
    description:
      'GFM blockquote alert (`> [!NOTE]`) — read-only compat. Preserves `> [!NOTE]` syntax on round-trip; insert a fresh Callout block for the full prop surface.',
    rendersAs: 'Callout',
    translateProps: (props) => props,
    serialize: (node, ctx) => {
      const props = node.attrs.props as
        | {
            type?: string;
            title?: string;
            collapsible?: boolean;
            defaultOpen?: boolean;
          }
        | undefined;
      const ACCEPTED_TYPES = new Set([
        'note',
        'tip',
        'important',
        'warning',
        'caution',
        'abstract',
        'info',
        'todo',
        'success',
        'question',
        'failure',
        'danger',
        'bug',
        'example',
        'quote',
      ]);
      const rawType = props?.type ?? 'note';
      const type = (ACCEPTED_TYPES.has(rawType.toLowerCase()) ? rawType : 'note').toUpperCase();
      const suffix = props?.collapsible ? (props.defaultOpen === false ? '-' : '+') : '';
      const titleSegment = props?.title ? ` ${props.title}` : '';
      const marker = {
        type: 'html' as const,
        value: `[!${type}]${suffix}${titleSegment}`,
      };
      const body = ctx.all(node).filter((child) => {
        if (child.type !== 'paragraph') return true;
        const para = child as { type: 'paragraph'; children?: unknown[] };
        return Array.isArray(para.children) && para.children.length > 0;
      });
      return {
        type: 'blockquote' as const,
        children: [marker, ...body] as never,
      };
    },
  },

  {
    name: 'CommonMarkImage',
    surface: 'compat',
    hasChildren: false,
    isSelfClosing: true,
    props: commonMarkImageProps,
    icon: 'Image',
    category: 'media',
    displayName: 'CommonMark Image',
    description:
      'CommonMark image (`![alt](src "title")`) — read-only compat. Preserves `![alt](src)` syntax on round-trip; insert a fresh Image block for the full HTML-native attribute surface (srcset, sizes, decoding, etc.).',
    rendersAs: 'img',
    translateProps: (props) => props,
    serialize: (node) => {
      const p = node.attrs.props as
        | { src?: string; alt?: string; title?: string; sourceUrl?: string }
        | undefined;
      const image = {
        type: 'image' as const,
        url: p?.sourceUrl ?? p?.src ?? '',
        alt: p?.alt ?? '',
        title: p?.title ?? null,
      };
      return {
        type: 'paragraph' as const,
        children: [image],
      };
    },
  },

  {
    name: 'WikiEmbedImage',
    surface: 'compat',
    hasChildren: false,
    isSelfClosing: true,
    props: wikiEmbedImageProps,
    icon: 'ZoomIn',
    category: 'media',
    displayName: 'Wiki Embed Image',
    description:
      'Obsidian-style `![[file.png]]` wiki-embed — read-only compat. Edit the alt-text via the alias slot; the embed target / anchor stay on the prop bag and round-trip byte-identical.',
    rendersAs: 'img',
    translateProps: (props) => {
      const alias = typeof props.alias === 'string' && props.alias.length > 0 ? props.alias : null;
      const target = typeof props.target === 'string' ? props.target : '';
      return {
        src: props.src,
        alt: alias ?? target,
      };
    },
    serialize: serializeWikiEmbed,
  },

  {
    name: 'WikiEmbedVideo',
    surface: 'compat',
    hasChildren: false,
    isSelfClosing: true,
    props: wikiEmbedVideoProps,
    icon: 'Film',
    category: 'media',
    displayName: 'Wiki Embed Video',
    description:
      'Obsidian-style `![[clip.mp4]]` wiki-embed — read-only compat. Edit the title via the alias slot; the embed target / anchor stay on the prop bag and round-trip byte-identical.',
    rendersAs: 'video',
    translateProps: (props) => {
      const alias = typeof props.alias === 'string' && props.alias.length > 0 ? props.alias : null;
      const target = typeof props.target === 'string' ? props.target : '';
      return {
        src: props.src,
        title: alias ?? target,
      };
    },
    serialize: serializeWikiEmbed,
  },

  {
    name: 'WikiEmbedAudio',
    surface: 'compat',
    hasChildren: false,
    isSelfClosing: true,
    props: wikiEmbedAudioProps,
    icon: 'Volume2',
    category: 'media',
    displayName: 'Wiki Embed Audio',
    description:
      'Obsidian-style `![[song.mp3]]` wiki-embed — read-only compat. Edit the title via the alias slot; the embed target / anchor stay on the prop bag and round-trip byte-identical.',
    rendersAs: 'audio',
    translateProps: (props) => {
      const alias = typeof props.alias === 'string' && props.alias.length > 0 ? props.alias : null;
      const target = typeof props.target === 'string' ? props.target : '';
      return {
        src: props.src,
        title: alias ?? target,
      };
    },
    serialize: serializeWikiEmbed,
  },

  {
    name: 'WikiEmbedFile',
    surface: 'compat',
    hasChildren: false,
    isSelfClosing: true,
    props: wikiEmbedFileProps,
    icon: 'Paperclip',
    category: 'media',
    displayName: 'Wiki Embed File',
    description:
      'Obsidian-style `![[file.zip]]` wiki-embed — read-only compat for arbitrary downloadable attachments. Renders through the `File` canonical (inline row with file-up icon + bold name + optional dim size). Edit the display name via the alias slot.',
    rendersAs: 'File',
    translateProps: (props) => {
      const alias = typeof props.alias === 'string' && props.alias.length > 0 ? props.alias : null;
      const size = typeof props.size === 'string' && props.size.length > 0 ? props.size : null;
      return {
        src: props.src,
        name: alias ?? undefined,
        size: size ?? undefined,
      };
    },
    serialize: serializeWikiEmbed,
  },

  {
    name: 'HtmlDetailsAccordion',
    surface: 'compat',
    hasChildren: true,
    props: htmlDetailsAccordionProps,
    icon: 'ChevronRight',
    category: 'content',
    displayName: 'HTML5 Details',
    description:
      'HTML5 `<details><summary>` collapsible — read-only compat. Preserves `<details>` syntax on round-trip; insert a fresh Accordion block for icon / description / group-name props.',
    rendersAs: 'Accordion',
    translateProps: (props) => props,
    serialize: (node, ctx) => {
      const p = node.attrs.props as
        | { title?: string; defaultOpen?: boolean; name?: string; id?: string }
        | undefined;
      const open = p?.defaultOpen ? ' open' : '';
      const nameAttr = p?.name ? ` name="${escapeHtmlAttr(p.name)}"` : '';
      const idAttr = p?.id ? ` id="${escapeHtmlAttr(p.id)}"` : '';
      const trimmedTitle = p?.title?.trim();
      const summary = trimmedTitle ? `<summary>${escapeHtmlText(trimmedTitle)}</summary>` : '';
      return {
        type: 'mdxJsxFlowElement' as const,
        name: 'HtmlDetailsAccordion',
        attributes: [],
        children: ctx.all(node) as never,
        data: {
          htmlBoundary: {
            opener: `<details${open}${nameAttr}${idAttr}>\n${summary}`,
            closer: '</details>',
          },
        },
      };
    },
  },
  {
    name: 'DollarMath',
    surface: 'compat',
    hasChildren: false,
    isSelfClosing: true,
    props: dollarMathProps,
    icon: 'Sigma',
    category: 'content',
    displayName: 'Dollar Math',
    description:
      'Block math via `$$…$$` syntax — read-only compat. Preserves `$$…$$` form on round-trip; insert a fresh Math block for the full prop surface (id, language).',
    rendersAs: 'Math',
    translateProps: (props) => props,
    serialize: (node) => {
      const p = node.attrs.props as { formula?: string } | undefined;
      return {
        type: 'math' as const,
        value: p?.formula ?? '',
      };
    },
  },
  {
    name: 'MathFence',
    surface: 'compat',
    hasChildren: false,
    isSelfClosing: true,
    props: mathFenceProps,
    icon: 'Sigma',
    category: 'content',
    displayName: 'Math Fence',
    description:
      'Block math via ` ```math ` fenced code syntax — read-only compat. Preserves the fence form on round-trip; insert a fresh Math block for the full prop surface (id, language).',
    rendersAs: 'Math',
    translateProps: (props) => props,
    serialize: (node) => {
      const p = node.attrs.props as { formula?: string } | undefined;
      return {
        type: 'code' as const,
        lang: 'math',
        meta: null,
        value: p?.formula ?? '',
      };
    },
  },
];
