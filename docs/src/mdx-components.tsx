import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { ImageZoom } from 'fumadocs-ui/components/image-zoom';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { AgentIcons } from '@/components/agent-icons';
import { CopyPrompt } from '@/components/copy-prompt';
import { CtaButton } from '@/components/cta-button';
import { DownloadButton } from '@/components/download-button';
import { HtmlPreview } from '@/components/html-preview';
import { McpInstall } from '@/components/mcp-install';
import { Mermaid } from '@/components/mermaid';
import { LayerStack, WhereToStart } from '@/components/overview-blocks';
import { Tab, Tabs } from '@/components/tabs';
import { VerifyExec } from '@/components/verify-exec';

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Accordion,
    Accordions,
    AgentIcons,
    Card,
    Cards,
    CopyPrompt,
    CtaButton,
    DownloadButton,
    HtmlPreview,
    Image: ImageZoom,
    LayerStack,
    McpInstall,
    Mermaid,
    Step,
    Steps,
    WhereToStart,
    Tab,
    Tabs,
    TypeTable,
    VerifyExec,
    ...components,
  };
}
