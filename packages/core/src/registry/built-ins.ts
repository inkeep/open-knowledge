/**
 * Built-ins manifest — canonical pack (Callout + Image + Video + Audio +
 * Accordion + Math + Mermaid + PDF + File + Tabs + Tab).
 *
 * KaTeX-lazy renderer for Math with γ-preserved source forms across
 * `<Math>`, `$$…$$`, ` ```math ` fence; mermaid-js renderer for
 * ` ```mermaid ` fences. The Mermaid canonical is named `MermaidFence`
 * (single `chart` prop, fence-only authoring); `Mermaid` is intentionally
 * NOT a registered descriptor name so legacy `<Mermaid />` JSX content
 * falls through to the wildcard `'*'` (raw-mdx editable source block).
 * The PDF canonical is a pdfjs-dist-backed multi-page canvas viewer with
 * its own toolbar.
 * `canonical-compat.test.ts` and `registry.test.ts` are the authoritative
 * count assertions and update with every canonical addition. The
 * compound-wrapper machinery is absent (`compound-wrappers.tsx` was deleted
 * and the precedent #29 compound-components bridge was retracted). Names that still appear in user content fall through to the
 * wildcard `'*'` descriptor (`hasChildren: true`, empty props) per
 * `createRegistry()` / `getOrWildcard()`.
 *
 * Per-component prop shapes (load-bearing):
 *   - Image — 8 props (src, alt, width, height, caption, title, loading, zoom)
 *     alongside the DIY `react-medium-image-zoom` renderer.
 *   - Callout — 7 props (GFM 5-type enum + title/icon/color/collapsible/defaultOpen).
 *   - Video — 11-prop shape (1 common + 10 advanced). HTML5 `<video>`
 *     for file-served media; YouTube URLs dispatch via `parseYouTubeUrl`
 *     to a `react-lite-youtube-embed` facade (thumbnail-then-iframe).
 *     Timestamps ride inside the URL (`?t=…` folded to `?start=N`); no
 *     dedicated `start` prop on the descriptor.
 *   - Audio — 7 props (src/title/autoPlay/loop/muted/preload + children for
 *     `<source>`/`<track>` passthrough); `hasChildren: true`.
 *   - Accordion — 6 props (title required + defaultOpen + icon + description +
 *     id + name + children). Standalone: no `<Accordions>` parent wrapper;
 *     HTML5 `<details>`/`<summary>` substrate; cross-browser exclusive-accordion
 *     grouping via HTML5 `<details name>`; no `variant` prop — Notion color-map
 *     absorption path is preserved separately.
 *
 * ── Intent-of-ship ───────────────────────────────────────────────────────
 *
 * This manifest is the shipped default for the OK editor. The greenfield
 * directive forbids shipping empty-scaffolding registries; this
 * file is the authoritative source of truth. Downstream embedders can call
 * `createRegistry()` + `.set(...)` to add their own descriptors, but the
 * canonical pack here is the in-app baseline.
 */
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

// ── Callout ──────────────────────────────────────────────────────────────────
//
// 7-prop surface: `type` (15-value enum — 5 GFM + 10 Obsidian-parity) + Mintlify-inspired `title`/`icon`/`color` +
// Obsidian-inspired `collapsible`/`defaultOpen`. The parser alias map
// (callout-transformer.ts:TYPE_ALIAS_MAP) folds rarer aliases
// (`summary`, `cite`, `error`, etc.) into one of the 15 first-class
// types pre-descriptor lookup. Schema-is-add-only (precedent #9) — the
// enum was widened from 5 to 15, never narrowed.
//
// `icon` is a string (not reactnode) because it encodes a lucide-react
// identifier namespace (e.g., `lucide:ChevronRight`) — resolved in the
// renderer to an `<Icon>` element. This lets γ round-trip the icon name
// byte-identical and keeps the PropPanel editable (reactnode props are hidden
// from the generic switch per `hasEditableProps` in JsxComponentView).

const calloutProps: PropDef[] = [
  // common — what the typical author actually picks per insert
  {
    name: 'type',
    type: 'enum',
    // 15 first-class types: 5 GFM + 10 Obsidian-parity. Aliases (summary,
    // tldr, check, done, help, faq, fail, missing, error, cite, idea,
    // hint, warn, attention) fold into one of these via the parser's
    // alias map. See `callout-transformer.ts`'s `TYPE_ALIAS_MAP`.
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
  // advanced — taste-and-edge-case knobs (custom icon override, accent color
  // override, foldable behavior). Default rendering is good enough for the
  // typical author; PropPanel collapses these under "Advanced".
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
    // Only meaningful when `collapsible: true` — a non-collapsible callout
    // has no open/closed state, so showing this control is misleading.
    hideWhen: (values) => values.collapsible !== true,
  },
  {
    name: 'children',
    type: 'reactnode',
    required: true,
    description: 'Callout content',
  },
];

// ── Lowercase HTML media canonicals — htmlImgProps / htmlVideoProps / htmlAudioProps ──
//
// Replaces the capitalized `imageProps` / `videoProps` / `audioProps` above
// once the canonical descriptor names flip from `Image` / `Video` / `Audio`
// to lowercase `img` / `video` / `audio`. Defined alongside the old arrays
// so the inflection is a single atomic swap.
//
// Two intentional shape changes vs. the predecessor arrays:
//
//   1. HTML-attr lowercase names — `autoplay` (not `autoPlay`), `playsinline`
//      (not `playsInline`), `fetchpriority`, `crossorigin`, `referrerpolicy`.
//      The descriptor `name` is the source-form attribute spelling that gets
//      emitted by `emitMdxJsx`, so storing lowercase makes the rendered MDX
//      match the HTML spec exactly. The React media components translate to
//      camelCase at the JSX boundary (where TypeScript's
//      `JSX.IntrinsicElements` types require it).
//
//   2. Common / advanced split via `advanced: true` — props that experienced
//      authors want available but don't edit on every insert (responsive
//      `srcset` / `sizes`, `decoding`, `fetchpriority`, `crossorigin`,
//      `referrerpolicy`, native HTML `title`, video `muted` / `loop` /
//      `playsinline` / `preload`) live under PropPanel's collapsed
//      "Advanced" section.
//
// `caption` and `zoom` are deliberately ABSENT from htmlImgProps:
//   - `caption` belongs on a compositional Frame v2 wrapper (Mintlify
//     pattern) — putting it on `<img>` bloats the storage shape and
//     pre-commits the design space.
//   - `zoom` is OK-specific (not HTML-native). The Image React component
//     always wraps in `<Zoom>`; Frame v2 will introduce `<Frame zoom={false}>`
//     as the opt-out path when it lands.

// htmlImgProps — 13 props (3 common + 10 advanced).
//
// Common: src + alt + align. Advanced: width + height + srcset + sizes +
// loading + title + decoding + fetchpriority + crossorigin + referrerpolicy.
//
// `width` / `height` are layout-shift-prevention specialist knobs — most
// authors lay out images with CSS or container width, not pixel dimensions.
// Demoted to advanced so the default PropPanel for a fresh image stays a
// simple form (src + alt + align). `align` is appended at index [12] so
// existing identity-shared index references in `commonMarkImageProps`
// stay stable (CommonMark `![alt](src "title")` has no alignment surface).
//
// Index map (used by commonMarkImageProps below — identity-shared):
//   [0] src         [4] srcset          [8]  decoding
//   [1] alt         [5] sizes           [9]  fetchpriority
//   [2] width       [6] loading         [10] crossorigin
//   [3] height      [7] title           [11] referrerpolicy
//                                       [12] align (canonical-only)
const htmlImgProps: PropDef[] = [
  // common
  {
    name: 'src',
    type: 'string',
    required: true,
    // Empty default so slash-insert pre-populates `src: ''`; the placeholder
    // predicate (`shouldRenderPlaceholder`) keys off `=== ''` to surface the
    // "Add an image" pill. Authored markdown like `<img />` (no attr) parses
    // to `src: undefined` and intentionally does NOT trigger the pill — the
    // strict-empty-string check distinguishes slash-insert (interactive
    // placeholder UX) from authored content (declared-empty respect).
    defaultValue: '',
    description: 'Image source URL',
    accept: ALLOWED_IMAGE_MIME_TYPES,
    autoFocus: true,
  },
  {
    name: 'alt',
    type: 'string',
    // Required because every accessible `<img>` needs an explicit alt
    // decision — descriptive text OR `alt=""` (decorative opt-in per WCAG
    // 1.1.1). No `defaultValue` means slash-insert leaves the key absent,
    // which the JsxComponentView `needsConfig` predicate keys off (key-
    // absence → fires the chrome-bar gear nudge). Authored `alt=""` parses
    // to `props.alt === ''` (key present, decorative) and does NOT fire.
    required: true,
    description: 'Alt text',
  },
  // advanced
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
    // Image alignment within the column. Stored at the descriptor level
    // so it serializes as `<img … align="left" />` in MDX and round-trips
    // through the parser. CSS keys off `data-align` on the
    // `JsxComponentView` wrapper (see `globals.css`). `'center'` is the
    // default both visually and at the descriptor — `omitOnDefault: true`
    // keeps the serializer from emitting `align="center"` on every
    // image, so existing docs without an explicit `align` stay byte-
    // stable on save.
    //
    // Surface: kept in the COMMON section (the loose `advanced: true` on
    // every entry above this one keeps its position) by NOT marking it
    // advanced. Authors changing alignment is a frequent tweak — surfacing
    // it flat in the PropPanel matches what the bubble-menu buttons do
    // visually.
    //
    // Appended at the end of the array so existing index references
    // (`htmlImgProps[0]` … `htmlImgProps[7]` in `commonMarkImageProps`)
    // stay stable. CommonMark `![alt](src "title")` syntax has no
    // alignment surface, so the compat shape doesn't include `align`.
    name: 'align',
    type: 'enum',
    // `center` first so the descriptor's declared default matches what
    // the wrapper-level CSS and bubble-menu buttons both treat as "no
    // explicit alignment" (referenced by other surfaces even though
    // PropPanel doesn't render this prop anymore).
    enumValues: ['center', 'left', 'right'],
    defaultValue: 'center',
    required: false,
    omitOnDefault: true,
    description: 'Alignment within the column',
    // Single alignment surface: the bubble menu's `ImageAlignButtons`
    // (rendered when an alignable jsxComponent is NodeSelected). Hiding
    // here suppresses the redundant PropPanel `Align` Select dropdown
    // that would otherwise sit alongside the bubble-menu trio + an
    // earlier chrome-bar trio; the prop still travels through the
    // registry (MCP queries, descriptor docs, render path) — only the
    // auto-generated PropPanel UI skips it.
    hidden: true,
  },
];

// embedProps — generic URL-iframe embed for arbitrary web content (docs,
// CodeSandbox, Figma, prototype links). Five props: `src` (required URL) +
// `title` (a11y label) + `width` + `height` + `align`. `width`/`height` are
// strings (CSS lengths — `rem`, `px`, `%`) so authors can lay out at the
// CSS level rather than guessing HTML pixel values. `align` mirrors the
// img descriptor so the bubble-menu alignment predicate (and the
// wrapper-level `text-align`-on-`data-align` CSS) compose without
// special-casing.
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
    // No `defaultValue` — the empty-string strip rule in
    // `serialize-helpers.ts` (`stringPropsOmittingEmpty`) keys off
    // `defaultValue === undefined`, so authoring `<Embed src="..." />`
    // without an explicit title round-trips byte-stable. Declaring
    // `defaultValue: ''` here would persist `title=""` on every save.
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
    // Bubble menu owns the single alignment surface for alignable
    // descriptors (Embed included via ALIGNABLE_DESCRIPTOR_NAMES);
    // PropPanel skips the redundant Select. Mirrors the same flag on
    // `htmlImgProps`'s `align` entry and `htmlVideoProps`'s `align`
    // entry — descriptive references so a future reordering inside
    // either array doesn't silently invalidate this cross-pointer.
    hidden: true,
  },
];

// htmlVideoProps — 12 props (2 common + 10 advanced).
//
// Common: src + align. Advanced: controls + autoplay + poster + width +
// height + title + muted + loop + playsinline + preload.
//
// `align` joined the common tier alongside `src` — same shape as
// `htmlImgProps`'s `align` entry (enum, `center` default,
// `omitOnDefault`) so the bubble-menu alignment predicate and the
// wrapper-level `text-align`-on-`data-align` CSS see the same contract
// across img / video / Embed.
//
// `controls` defaults true (most authors want them); `autoplay` is niche and
// destructive; `poster` is power-user nice-to-have. Demoting these keeps the
// fresh-insert PropPanel a single src field — same shape as Notion's video
// block. Lowercase HTML-attr names: `autoplay`, `playsinline`. Video.tsx maps
// to React's camelCase (`autoPlay`, `playsInline`) at the JSX boundary.
const htmlVideoProps: PropDef[] = [
  // common
  {
    name: 'src',
    type: 'string',
    required: true,
    defaultValue: '',
    description: 'Video source URL',
    accept: ALLOWED_VIDEO_MIME_TYPES,
    autoFocus: true,
  },
  // advanced
  {
    name: 'controls',
    type: 'boolean',
    required: false,
    defaultValue: true,
    advanced: true,
    omitOnDefault: true,
    description: 'Show native HTML5 video controls (defaults to true)',
    // Vimeo's Player SDK accepts the `controls` prop but the service
    // only honors `controls=0` for PRO/Business accounts — free
    // accounts silently ignore it and always show the standard player
    // chrome. We can't detect account tier client-side, so the field
    // would set up an authoring expectation we can't deliver. Hide it
    // for Vimeo URLs; YouTube + HTML5 (the two paths that honor it
    // unconditionally) keep the toggle.
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
    // YouTube honors `poster` (the lite-embed lib swaps in the supplied
    // image as the thumbnail). Vimeo doesn't expose a poster override —
    // its embed always serves the video's own thumbnail — so hide the
    // field for Vimeo URLs to avoid pretending it does something.
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
    // Loom doesn't expose a loop URL param — the embed plays once.
    // YouTube + Vimeo honor loop via lib-level setters, so this hide is
    // Loom-only.
    hideWhen: (values) => typeof values.src === 'string' && isLoomUrl(values.src),
  },
  {
    name: 'playsinline',
    type: 'boolean',
    required: false,
    advanced: true,
    description: 'Play inline on iOS rather than entering fullscreen',
    // Vimeo's lib reads `playsInline` once in its initial iframe URL
    // (getInitialOptions) and has no Vimeo Player SDK setter to update
    // it post-mount — toggling the field after the iframe loaded would
    // be a no-op until the next remount. Combined with: Vimeo's default
    // is already inline, and this is iOS-Safari-only behavior, the
    // setting can't reliably do anything from the PropPanel. Hide for
    // Vimeo URLs; YouTube + HTML5 honor it on next iframe paint.
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
    // No iframe-embed equivalent for either provider — YouTube's lite-
    // embed facade defers the iframe entirely until click, and Vimeo's
    // Player SDK manages preload at the player layer. Video.tsx ignores
    // `preload` for both at render time; hide it from the PropPanel so
    // the setting doesn't pretend to do something it doesn't.
    hideWhen: (values) =>
      typeof values.src === 'string' &&
      (parseYouTubeUrl(values.src) !== null || isVimeoUrl(values.src) || isLoomUrl(values.src)),
  },
  {
    // Video alignment within the column. Same shape as `htmlImgProps[12]`
    // — descriptor-level `enum` with `center` default and `omitOnDefault`
    // so docs authored before alignment landed stay byte-stable on save.
    // CSS keys off `data-align` on the `JsxComponentView` wrapper (see
    // `globals.css`); the wrapper-level `text-align` rule positions the
    // inline-block `.ok-video` child within the column.
    //
    // Kept in the COMMON section (no `advanced: true`) — alignment is a
    // frequent tweak and matches the img + Embed parallel surface.
    name: 'align',
    type: 'enum',
    // `center` first so the descriptor's declared default matches the
    // wrapper-level CSS's "no explicit alignment" rendering. Mirrors
    // `htmlImgProps`'s `align` entry's ordering rationale.
    enumValues: ['center', 'left', 'right'],
    defaultValue: 'center',
    required: false,
    omitOnDefault: true,
    description: 'Alignment within the column',
    // Single alignment surface: bubble menu. PropPanel doesn't render a
    // Select for this prop. Mirrors the same flag on `htmlImgProps`'s
    // align entry and `embedProps`'s align entry.
    hidden: true,
  },
];

// htmlAudioProps — 7 props (1 common + 6 advanced).
//
// Common: src. Advanced: controls + autoplay + title + muted + loop + preload.
//
// `controls` is an explicit prop (default true) — Audio.tsx no longer
// hardcodes always-on. Authors who want a chrome-less audio set
// `controls={false}` from the Advanced section instead of escaping to raw
// HTML. Demoted to keep the typical insert a single src field.
const htmlAudioProps: PropDef[] = [
  // common
  {
    name: 'src',
    type: 'string',
    required: true,
    defaultValue: '',
    description: 'Audio source URL',
    accept: ALLOWED_AUDIO_MIME_TYPES,
    autoFocus: true,
  },
  // advanced
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

// ── Accordion ────────────────────────────────────────────────────────────────
//
// 6-prop standalone accordion matching Mintlify Accordion's surface + HTML5
// `name` attr.
//
// ── Constraints (load-bearing) ───────────────────────────────────────────────
//
//   - NO `variant` prop → Notion color-map absorption (default/gray/brown/
//     _background) is de-prioritized. Precedent #9 schema-add-only makes
//     adding `variant` later free, but dropping now when nothing consumes
//     it is permanent lock-in avoidance.
//   - STANDALONE → ships without `<Accordions>` / `<AccordionGroup>` parent
//     wrapper. Matches Mintlify's standalone-Accordion stance; diverges from
//     Fumadocs's Radix-requires-parent pattern. Cross-browser exclusive-
//     accordion grouping via HTML5 `<details name="...">` (Chrome 120+,
//     Safari 17.2+, Firefox 130+) — no wrapper component needed.
//   - HTML5 `<details>` SUBSTRATE → native browser collapse/expand (no JS
//     toggle handler, no Radix-style animation state machine). Rotation on
//     open/close via CSS transform keyed on the `[open]` attribute; styling
//     flows through OK shadcn tokens in globals.css (no `--color-fd-*`).
//
// ── Namespace collision ──────────────────────────────────────────────────────
//
// Fumadocs `Accordion` + `Accordions` descriptors are not registered; the
// foundation `Accordion` is a full replacement. Clean cut, not a schema
// extension — both shapes have zero attr overlap beyond `title` (fumadocs
// required an `<Accordions>` parent; ours is standalone).
//
// ── `children` semantics ─────────────────────────────────────────────────────
//
// `hasChildren: true`. The summary (title/icon/description) is rendered as
// non-editable chrome inside `<summary>`; children render inside the body
// region under the fold. Precedent #26 (all user content visible): the body
// DOM is retained even when collapsed — browsers display:none inside the
// closed `<details>`, but PM children stay live so editing doesn't lose state.

const accordionProps: PropDef[] = [
  // common — every accordion needs a title; defaultOpen is the one stylistic
  // knob the typical author actually picks (start open vs closed).
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
  // advanced — custom icon override, subtitle, deep-link anchor, exclusive-
  // group identifier. All taste-and-edge-case territory; default rendering
  // (lucide ChevronRight + bare title) is good enough for typical use.
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

// ── Compat descriptor prop subsets ───────────────────────────────────────────
//
// Compat descriptors expose ONLY the props their source syntax can natively
// express. Names are canonical (identity translateProps in v1) so storage stays
// uniform — node.attrs.props uses the same keys regardless of which descriptor
// is active. Convert-to-canonical is identity (same prop names, just enabling
// the canonical's full superset).

const gfmCalloutProps: PropDef[] = [
  // GFM `[!TYPE]` marker → type
  calloutProps[0],
  // Obsidian title text after the marker → title
  calloutProps[1],
  // Obsidian `+` / `-` suffix → collapsible + defaultOpen
  calloutProps[4],
  calloutProps[5],
  // Body is the reactnode children slot — same as canonical Callout.
  calloutProps[6],
];

const commonMarkImageProps: PropDef[] = [
  // `![alt](src "title")` — three native fields. Identity-shared with
  // htmlImgProps so a future change to `src` / `alt` / `title` PropDef
  // metadata applies to both the canonical and the compat in lockstep.
  // `title` carries `advanced: true` from htmlImgProps[7] — in
  // CommonMarkImage's PropPanel `title` appears under Advanced, consistent
  // with how it appears under `<img>`. Acceptable because authors rarely
  // edit CommonMark image titles, and consistency across the canonical /
  // compat pair outweighs surfacing it flat.
  htmlImgProps[0], // src
  htmlImgProps[1], // alt
  htmlImgProps[7], // title (advanced via shared identity)
];

const htmlDetailsAccordionProps: PropDef[] = [
  // `<summary>` inner text → title
  accordionProps[0],
  // `open` HTML attr → defaultOpen
  accordionProps[1],
  // `id` HTML attr → id (deep-link anchor)
  accordionProps[4],
  // `name` HTML attr → name (HTML5 mutex group)
  accordionProps[5],
];

// WikiEmbed* compats expose only what `![[file.ext|alias]]` can encode — a
// single editable string slot. Stored target / anchor stay on the prop bag
// alongside `alias` so `serialize` can rebuild byte-identical source bytes,
// but they are not surfaced in PropPanel (the parser owns them; the user
// edits the alias and nothing else).
//
// The three sibling PropDef arrays differ only in the description string —
// kept distinct so PropPanel renders the user-friendly alias-syntax example
// matching the file kind they're editing (image / video / audio).
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

// ── Tabs / Tab ───────────────────────────────────────────────────────────────
//
// Notion-style horizontal tab strip + active panel below. The descriptor pair
// mirrors Accordion's surface as closely as possible — both are JSX-only,
// canonical, hasChildren containers. Tabs holds Tab children; Tab holds
// arbitrary block content.
//
// Tabs uses `emptyChildName: 'Tab'` (see descriptor below) — wires the
// standard `+ Add Tab` hover pill via JsxComponentView's container
// affordance, same as Callout. Insertion routes through `createChildNode`
// (slash-command/component-items.tsx) so the inserted Tab is the exact
// same PM shape as the slash-command-seeded starter Tabs. The previous
// attempt to set this on an earlier branch state surfaced y-prosemirror
// schema throws on source-edit roundtrip; that branch's `createChildNode`
// dispatch table predated Tab being a canonical descriptor.
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

// Math + Mermaid ----------------------------------
const mathProps: PropDef[] = [
  {
    name: 'formula',
    type: 'string',
    required: true,
    autoFocus: true,
    // Multi-line LaTeX is the typical authoring shape (`\begin{align}…`,
    // matrices, `\frac`-heavy expressions). Renders as a CM6 stex-mode
    // editor (line numbers + bracket matching + syntax highlighting)
    // instead of a single-line `<input>`. See `CodeMirrorPropInput`.
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
// Fence-only authoring: single `chart` prop. `id` and `theme` are absent
// because neither is expressible in ` ```mermaid ` fence syntax. The
// canonical descriptor is named `MermaidFence` (not `Mermaid`) — the
// `Mermaid` name is not registered, so `<Mermaid />` JSX content falls
// through to the wildcard `'*'` (raw-mdx editable source block).
const mermaidProps: PropDef[] = [
  {
    name: 'chart',
    type: 'string',
    required: true,
    // `hidden: true` suppresses this prop from the PropPanel UI without
    // dropping it from the descriptor — serialization, the build-registry
    // JSDoc extractor, MCP `palette` queries, and the
    // `hasEditableProps` chrome-gear gate all keep working off the
    // declared schema. With every prop hidden, `hasEditableProps` returns
    // false and the gear icon on the node-view chrome is suppressed
    // entirely (see `packages/app/src/editor/extensions/JsxComponentView.tsx`).
    //
    // The dedicated fullscreen "Edit source" pen-icon modal is the
    // canonical authoring surface for Mermaid charts — it gets the full
    // viewport, syntax highlighting, line numbers, and the same
    // codemirror-lang-mermaid grammar the inline panel had, without
    // squeezing a 10+ line diagram into the narrow PropPanel popover.
    // Inline ` ```mermaid ` fence edits in source mode keep working
    // identically.
    hidden: true,
    description:
      'Mermaid chart source (graph / flowchart / sequenceDiagram / class / state / etc.)',
  },
];

// WikiEmbedFile compat — `![[archive.zip]]` / `![[handbook.docx]]` /
// `![[doc.pdf]]` / etc. for any attachment extension. Single `alias`
// slot for `![[file|title]]` override syntax — the canonical `File`
// accepts `name` rather than `title`, and the compat's `translateProps`
// performs that remap.
//
// PDFs land in this compat too: the wikilink/drop form (`![[doc.pdf]]`)
// renders as a File row alongside docx / zip / etc. The pdfjs canvas
// viewer is a SEPARATE authoring path — explicit `<Pdf src="..." />`
// JSX renders through the `Pdf` canonical (`Pdf.tsx`). This split keeps
// the dropped-attachment UX uniform across types while preserving the
// inline-preview opt-in.
const wikiEmbedFileProps: PropDef[] = [
  {
    name: 'alias',
    type: 'string',
    required: false,
    defaultValue: '',
    description: 'Display name override (Obsidian alias syntax: `![[file.zip|label]]`)',
  },
];

// File canonical — minimal-surface dispatch target for the WikiEmbedFile
// compat. The user-authored shape is `![[file.ext]]` wikilink, NOT the JSX
// `<File>` form. The canonical exists so the compat has somewhere to render
// through (`rendersAs: 'File'` resolves to this descriptor's React
// component); its prop schema is intentionally minimal because the compat
// is the only path that materializes it.
//
// The compat passes `name` (from wikilink alias) and `size` (from upload
// metadata, when available) through `translateProps` even though those
// aren't declared here. The renderer (`File.tsx`) reads them from the
// passed prop bag — descriptor props gate PropPanel + serialization, not
// runtime renderer arity. Keeping `name`/`size`/`title` undeclared at the
// canonical means hand-authored `<File>` JSX gets a one-prop PropPanel
// (just `src`); to override the display name in MDX the author writes
// `![[file.ext|Display Name]]`.
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

// Pdf canonical props — minimal surface (src + title + anchor). Unlike
// `img`/`video`/`audio` (which mirror the full HTML attribute set), there
// is no `<pdf>` HTML element — the Pdf.tsx canonical renders pages to
// `<canvas>` via `pdfjs-dist`. The 3-prop set is the union of (a) the
// document URL (`src`), (b) the accessibility name (`title`), and (c)
// the Obsidian viewer-parameter string (`anchor` — `page=N`, `height=N`,
// etc., parsed at render time).
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

// ── Mirror + MirrorSource ────────────────────────────────────────────────────
//
// Master/copy transclusion. A `<MirrorSource id="…">…</MirrorSource>` block
// authored in one doc is the editable source-of-truth; `<Mirror src="…"
// anchor="…" />` references render its content read-only at every call-site.
// Edits happen ONLY at the source. The descriptor pair is the agent-facing
// authoring surface; render-time resolution + cross-doc Y.Doc subscription
// live in the editor NodeView.

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

// ── Compat serialize helpers ─────────────────────────────────────────────────

/** Minimal HTML attribute-value escape (matches the lossiness of the parser). */
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Minimal HTML text-content escape for `<summary>` inner text. */
function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Shared serialize for the WikiEmbed* compat descriptors (Image / Video /
 * Audio / PDF). All four render `![[target|alias]]` source bytes via
 * wiki-embed mdast — only `rendersAs` and `translateProps` differ across
 * the four descriptors, the source-form emit is identical. Reads the prop
 * bag from `node.attrs.props`; an absent / non-string `target` collapses
 * to `''`, matching the wikiLinkEmbed parser's default.
 */
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

// ── Manifest ─────────────────────────────────────────────────────────────────
//
// Rule for choosing canonical descriptor casing:
//
//   Lowercase (HTML-tag) when (a) the HTML primitive carries an attribute set
//   complete enough that nothing OK-specific needs to live as a prop AND
//   (b) compositional wrappers (Frame, Figure, etc.) are the canonical home
//   for OK-specific affordances around the primitive.
//
//   Capitalized when (a) HTML has no primitive that covers the surface
//   (e.g., Callout) OR (b) the closest HTML primitive is structurally a
//   subset of the descriptor (e.g., Accordion vs <details>).

export const builtInComponents: JsxComponentMeta[] = [
  // Content
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
      // GFM 5
      'note',
      'tip',
      'important',
      'warning',
      'caution',
      // Obsidian-parity 10
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
      // Generic
      'alert',
      'admonition',
      'callout',
    ],
    serialize: (node, ctx) => emitMdxJsx('Callout', node, ctx, calloutProps),
  },

  // Media — lowercase per the rule above. HTML's `<img>` / `<video>` /
  // `<audio>` carry attribute sets complete enough that no OK-specific prop
  // belongs on the primitive; caption / Frame-style decorations belong on a
  // compositional wrapper (Frame v2). `displayName` stays capitalized for
  // slash-menu and PropPanel header readability.
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
    // Pdf canonical — `pdfjs-dist`-backed multi-page canvas viewer
    // with our own toolbar (thumbnails toggle, title, jump-to-page
    // input, zoom in/out, layout dropdown). No `<pdf>` HTML element
    // exists, so the descriptor name is
    // capitalized to match the React JSX convention for non-native
    // components (siblings: Callout, Accordion). The lowercase
    // spelling stays reserved for canonicals that DO have an HTML
    // primitive (img / video / audio). Dispatch key into
    // `componentMap['Pdf']`. The wikilink form `![[doc.pdf]]` routes
    // through `WikiEmbedFile` → `File` (inline-row chrome, same as
    // .docx / .zip / etc.) — authors write the canonical `<Pdf>` JSX
    // directly when they want the embedded multi-page reader experience.
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
    // File canonical — generic file attachment for arbitrary types
    // (.zip, .docx, .pptx, .xlsx, .pdf, …). Renders as a Notion-style
    // inline row — file-up icon + bold filename + optional dim size —
    // via a styled `<a>` link in `File.tsx`. Click opens the file in
    // a new tab for preview (no `download` attribute, so PDFs / images
    // / text preview-render in the new tab; explicit save is via the
    // bubble-menu Download button when the row is NodeSelected).
    // Capitalized because no `<file>` HTML element exists (same
    // convention as `Pdf`, `Callout`, `Accordion`).
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
    // Embed canonical — generic iframe for arbitrary web content
    // (docs pages, CodeSandbox, Figma, demo URLs). Capitalized because no
    // `<embed>` semantic this matches (HTML's `<embed>` is for plugin
    // objects, not the iframe pattern we want here). Same convention as
    // `Pdf` / `File` / `Callout`.
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

  // Content
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
  // Tabs + Tab canonical pair — Notion-style pill strip + active-panel
  // container. Pair of jsxComponent descriptors; Tabs holds Tab children,
  // each Tab holds arbitrary block content.
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
  // Math + Mermaid canonical descriptors
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
    // Descriptor is named `MermaidFence` (not `Mermaid`) so legacy
    // `<Mermaid chart="…" />` JSX content does NOT match this descriptor at
    // parse time — it falls through to the wildcard `'*'` (raw-mdx editable
    // source block). The descriptor name `MermaidFence` (not `Mermaid`) is
    // the load-bearing mechanism that enforces fence-only authoring — a
    // descriptor named `Mermaid` would silently re-admit the JSX surface via
    // the mdxJsx parse path. Slash-menu authors see "Mermaid" via
    // `displayName`; only the AST node name and componentMap key differ.
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
    // Fence-only serialize. Emits a `code` mdast node with `lang: 'mermaid'`
    // so remark-stringify produces ` ```mermaid …``` ` on dirty save —
    // matches the math-fence pattern (MathFence compat). The parse-side
    // `mermaid-promoter` walks `code{lang:'mermaid'}` mdast →
    // `mdxJsxFlowElement(MermaidFence, {chart})`, so the round-trip is
    // fence → JSX (in-memory, name=MermaidFence) → fence (on disk).
    // Pristine bytes are preserved by Phase B's position-slice walker.
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
  // Mirror + MirrorSource canonical pair — master/copy block transclusion.
  // MirrorSource holds editable content; Mirror renders the source verbatim
  // read-only at every call-site. Rendering and cross-doc Y.Doc subscription
  // are implemented in the editor NodeViews; the descriptors here exist so
  // the parse pipeline round-trips the JSX shape and so the canonical
  // inventory exposes them on the agent surface.
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
    // No `placeholder` field: Mirror's `useMirrorSource` hook renders its
    // own explanatory `empty-props` state ("Mirror — pick a source. Set src
    // + anchor…") which is richer than the generic placeholder pill. Adding
    // `defaultValue: ''` on `src` would route this through the pill UX but
    // also violate the key-absence invariant (precedent #46) for non-upload-
    // flow descriptors. Mirror uses neither path.
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

  // ── Compat descriptors ─────────────────────────────────────────────────────
  // Read-only; never offered for new insertion (slash menu filters to
  // `surface: 'canonical'`). Each owns its own source-form serialize so
  // round-trip preserves the source bytes even after a user prop edit.

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
      // Accept the full 15 first-class types — `> [!TYPE]` markdown
      // syntax can encode any single-word token, and the parse-side
      // alias map normalizes them to first-class types. Emit the
      // resolved type uppercase so re-parse via `remark-github-alerts`
      // stays idempotent. Truly unknown tokens (set via `setNodeMarkup`
      // by some external source) fall back to 'note' for syntax safety.
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
      // Obsidian `+` / `-` suffix encoding: collapsible+defaultOpen → `+`,
      // collapsible+!defaultOpen → `-`, !collapsible → no suffix.
      const suffix = props?.collapsible ? (props.defaultOpen === false ? '-' : '+') : '';
      const titleSegment = props?.title ? ` ${props.title}` : '';
      // Emit the alert marker as `html` mdast so remark-stringify does NOT
      // escape the `[` (text-node emit produces `\[!NOTE]`, breaking the
      // alerts-plugin re-parse). The blockquote container handler prefixes
      // every line with `> `; remark-github-alerts re-parses the resulting
      // `> [!TYPE]\n>\n> body` shape identically on round-trip → idempotent
      // dirty path holds.
      const marker = {
        type: 'html' as const,
        value: `[!${type}]${suffix}${titleSegment}`,
      };
      // Strip empty paragraphs from the body — a `> [!TYPE]\n>\n> body` source
      // re-parses with an empty paragraph between the marker line and the
      // body, and emitting it back through the blockquote handler would add
      // another blank `> ` line on every round-trip (idempotence violation).
      // Empty paragraphs are layout-only artifacts of the alert-block parse
      // and don't carry semantic content; dropping them produces a stable
      // fixed point under dirty-path re-emit.
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
        // `sourceUrl` holds the authored doc-relative URL when the parse
        // pipeline rewrote `src` to a server-absolute form — emit the
        // authored bytes so an edited doc round-trips byte-identical.
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

  // Video / audio sibling compats. Both canonicals (Video.tsx / Audio.tsx)
  // expose `title` as the user-visible authored string — neither HTML5 element
  // accepts an `alt` attribute. Alias maps to `title` for both. The serialize
  // shape is identical to WikiEmbedImage's (shared `serializeWikiEmbed`
  // helper); only `rendersAs` and the prop mapping differ.
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
    // WikiEmbedFile — Obsidian-style `![[archive.zip]]` / `![[handbook.docx]]` / `![[doc.pdf]]`
    // compat that materializes from drop-file (via `pickInsertShape` →
    // `'jsx-file'`) and from authored MDX `![[]]` syntax. Renders through
    // the `File` canonical (Notion-style inline row in `File.tsx`). Catches
    // every non-media wiki-embed including PDF — the wikilink/drop form
    // treats a dropped PDF as an attachment row, not the pdfjs viewer
    // (the `<Pdf>` JSX form is the opt-in for the embedded reader).
    // Extension allowlist lives in `FILE_ATTACHMENT_EXTENSIONS`; the
    // wiki-embed handler at `markdown/index.ts` dispatches block-context
    // wiki-embeds whose extension is in that set to this compat.
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
      // `size` carries through verbatim when present — set by the upload
      // pipeline (`uploadAndInsert` → `formatFileSize(file.size)`) at
      // drop time, AND by the server-side `resolveSize` callback
      // (`statSync` against the resolved disk path → `formatFileSize`)
      // at parse time. Remote URLs and client-only parses lack a
      // resolver, so `File.tsx` simply omits the size span when absent.
      const size = typeof props.size === 'string' && props.size.length > 0 ? props.size : null;
      return {
        src: props.src,
        // alias is the only author-editable surface on the wiki-embed; map
        // it to the canonical's `name` prop. When alias is absent, leave
        // `name` unset so File.tsx's `basenameFromUrl(src)` fallback runs
        // (strips query string + directory prefix, percent-decodes).
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
      // Trim the title before emit — the parser strips leading/trailing
      // whitespace inside `<summary>`, so an un-trimmed title would round-trip
      // to a trimmed re-parse and break dirty-path idempotence. An empty
      // title (whitespace-only) emits no summary tag at all.
      const trimmedTitle = p?.title?.trim();
      const summary = trimmedTitle ? `<summary>${escapeHtmlText(trimmedTitle)}</summary>` : '';
      // Body is rendered by the to-markdown handler via state.containerFlow
      // when `data.htmlBoundary` is set — emit a marker mdxJsxFlowElement
      // carrying the opener/closer strings and the live mdast body children.
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
  // Math compat descriptors — pair with the Math canonical above.
  // Mermaid has no compat row: the fence IS the canonical form (the
  // canonical descriptor is named `MermaidFence` and serializes to
  // ` ```mermaid `).
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
      // Emit `math` mdast — `mdast-util-math` (registered via `remarkMath`
      // on the serialize side of pipeline.ts) re-stringifies it as `$$…$$`,
      // closing the round-trip on the dirty path. Pristine path uses γ
      // sourceRaw and never reaches this serialize fn.
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
      // Emit `code` mdast with lang:'math' — remark-stringify's default code
      // handler emits a fenced ` ```math `…``` ` block, closing the
      // round-trip on the dirty path. Pristine path uses γ sourceRaw.
      return {
        type: 'code' as const,
        lang: 'math',
        meta: null,
        value: p?.formula ?? '',
      };
    },
  },
];
