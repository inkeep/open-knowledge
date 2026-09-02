/**
 * Maps component name → React component for the descriptor registry.
 *
 * The registered inventory is the `componentMap` object below — the
 * canonical descriptor list lives in core's `built-ins.ts`. The notes
 * that follow call out renderer-specific quirks for a subset of entries;
 * they are not an exhaustive inventory (the map itself is).
 * Each canonical entry is a DIY renderer — Callout is a 7-prop GFM shape
 * at `./Callout`, Image wraps `react-medium-image-zoom` (8-prop at
 * `./Image`), Video is a pure HTML5 `<video>` wrapper (9-prop at `./Video`
 * — no URL sniffing, no iframe emission), Audio is a pure HTML5
 * `<audio>` wrapper (7-prop at `./Audio`, `hasChildren: true` for
 * `<source>` / `<track>` passthrough), Accordion is a standalone HTML5
 * `<details>`/`<summary>` wrapper (6-prop at `./Accordion`
 * — no `variant`, no `<Accordions>` parent wrapper; cross-browser exclusive
 * grouping via HTML5 `<details name>`), Math is a KaTeX-lazy renderer at
 * `./Math`, MermaidFence is a mermaid-js v11 lazy renderer at `./Mermaid`
 * (re-introduces support that was removed — replaces the
 * placeholder stub deleted; the descriptor
 * is named `MermaidFence` so `<Mermaid />` JSX falls through to the
 * wildcard, enforcing fence-only authoring), Pdf is a
 * `pdfjs-dist`-backed multi-page canvas viewer with our own toolbar
 * (3-prop shape at `./Pdf`; `anchor`-string parsed at render time for
 * `#page=N` / `#height=N` viewer parameters), and File is a generic
 * file-attachment row (1-prop canonical at `./File`; styled `<a>`
 * link with icon + filename + optional dim size — Notion-style inline
 * row, no card chrome). The pdfjs library is dynamic-imported via a
 * module-level singleton so it stays out of the main app bundle.
 *
 * Compound-component machinery (Tabs/Tab + Accordions/Accordion)
 * was cut along with the Context Bridge Registry. Tabs/Tab
 * returned with an ephemeral-state design: `Tabs.tsx`'s
 * `useState(activeIndex)` plus a single `data-active-index` attribute on
 * the content wrapper drive CSS-only panel visibility — no cross-NodeView
 * React context, no DOM mutation on PM-managed children. Tab and Tabs are
 * the canonical pack's only compound parent today (Tabs declares
 * `emptyChildName: 'Tab'`).
 *
 * Descriptor names no longer in `componentMap` — Banner, Card, Cards, Step,
 * Steps, Accordions (fumadocs compound parent), Files, Folder, TypeTable,
 * InlineTOC — fall through to the `'*'` wildcard per
 * `registry/index.ts:getDescriptor`. Per-Precedent #30 the children of those
 * unregistered components stay editable (wildcard `hasChildren: true`).
 *
 * '*' maps to UnregisteredBadgeRender for the wildcard fallback.
 */
import { Accordion } from './Accordion.tsx';
import { AlignBlock } from './AlignBlock.tsx';
import { Audio } from './Audio.tsx';
import { Callout } from './Callout.tsx';
import { Embed } from './Embed.tsx';
import { ExcalidrawEmbed } from './ExcalidrawEmbed.tsx';
import { File } from './File.tsx';
import { Image } from './Image.tsx';
import { MathView } from './Math.tsx';
import { MermaidView } from './Mermaid.tsx';
import { Mirror } from './Mirror.tsx';
import { MirrorSource } from './MirrorSource.tsx';
import { Pdf } from './Pdf.tsx';
import { Tab } from './Tab.tsx';
import { Tabs } from './Tabs.tsx';
import { Video } from './Video.tsx';

function UnregisteredBadgeRender(props: { children?: React.ReactNode }) {
  return <div className="prose-no-margin">{props.children}</div>;
}

// biome-ignore lint/suspicious/noExplicitAny: Component props are heterogeneous across the canonical pack + transitional shim imports; no single prop type covers all
export const componentMap: Record<string, React.ComponentType<any>> = {
  Callout,
  img: Image,
  video: Video,
  audio: Audio,
  Pdf,
  File,
  Embed,
  Excalidraw: ExcalidrawEmbed,
  Accordion,
  // biome-ignore lint/suspicious/noExplicitAny: mirrors componentMap's heterogeneous prop shape
  Toggle: (props: any) => <Accordion {...props} title={props.title ?? 'Toggle'} />,
  HtmlAlignBlock: AlignBlock,
  Tabs,
  Tab,
  Math: MathView,
  MermaidFence: MermaidView,
  Mirror,
  MirrorSource,
  '*': UnregisteredBadgeRender,
};
