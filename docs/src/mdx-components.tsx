import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { ImageZoom } from 'fumadocs-ui/components/image-zoom';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import { icons } from 'lucide-react';
import type { MDXComponents } from 'mdx/types';
import { AgentIcons } from '@/components/agent-icons';
import { ComponentPreview } from '@/components/component-preview';
import { CopyPrompt } from '@/components/copy-prompt';
import { CtaButton } from '@/components/cta-button';
import { DownloadButton } from '@/components/download-button';
import { HtmlPreview } from '@/components/html-preview';
import { McpInstall } from '@/components/mcp-install';
import { Mermaid } from '@/components/mermaid';
import { LayerStack, WhereToStart } from '@/components/overview-blocks';
import { AccordionPreview } from '@/components/previews/accordion-preview';
import { CalloutPreview } from '@/components/previews/callout-preview';
import { FilePreview } from '@/components/previews/file-preview';
import { MathPreview } from '@/components/previews/math-preview';
import {
  AudioPreview,
  EmbedPreview,
  ImgPreview,
  PdfPreview,
  VideoPreview,
} from '@/components/previews/media-previews';
import { MirrorPreview, MirrorSourcePreview } from '@/components/previews/mirror-previews';
import { TabPreview, TabsPreview } from '@/components/previews/tabs-preview';
import { Tab, Tabs } from '@/components/tabs';
import { VerifyExec } from '@/components/verify-exec';

function InlineIcon({ name, label }: { name: keyof typeof icons; label?: string }) {
  const Icon = icons[name];
  return (
    <Icon
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className="-mt-0.5 inline size-4 align-middle text-amber-500"
    />
  );
}

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Accordion,
    AccordionPreview,
    Accordions,
    AgentIcons,
    AudioPreview,
    CalloutPreview,
    Card,
    Cards,
    ComponentPreview,
    CopyPrompt,
    CtaButton,
    DownloadButton,
    EmbedPreview,
    FilePreview,
    HtmlPreview,
    Image: ImageZoom,
    ImgPreview,
    InlineIcon,
    LayerStack,
    MathPreview,
    McpInstall,
    Mermaid,
    MirrorPreview,
    MirrorSourcePreview,
    PdfPreview,
    Step,
    Steps,
    WhereToStart,
    Tab,
    TabPreview,
    Tabs,
    TabsPreview,
    VideoPreview,
    TypeTable,
    VerifyExec,
    ...components,
  };
}
