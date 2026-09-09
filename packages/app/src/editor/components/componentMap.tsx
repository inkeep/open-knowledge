/**
 * Per-Precedent #30 the children of those unregistered components stay editable (wildcard
 * `hasChildren: true`).
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
