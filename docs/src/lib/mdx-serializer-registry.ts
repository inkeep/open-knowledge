import { visit } from 'unist-util-visit';
import { AGENTS } from '@/components/agent-icons';
import { mcpInstallMarkdown } from '@/components/mcp-install';
import { LAYERS, PATHS } from '@/components/overview-blocks';
import { verifyExecMarkdown } from '@/components/verify-exec';
import {
  DOWNLOAD_PAGE_HREF,
  DOWNLOAD_TARGETS,
  WEB_APP_HREF,
  WEB_APP_LABEL,
} from '@/lib/download-targets';
import { parseAttributeLiteral } from '@/lib/mdx-attribute-literal';
import {
  type ComponentDisposition,
  escapeInlineProse,
  inlineCodeSpan,
  longestBacktickRun,
  type MdxJsxNode,
  markdownLink,
  requiredLiteral,
  type SerializerApi,
  type SerializerRegistry,
} from '@/lib/mdx-serializer';

function cellSeparators(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function tableCell(value: string): string {
  return cellSeparators(escapeInlineProse(value));
}

function codeCell(value: string): string {
  return cellSeparators(code(value));
}

const code = inlineCodeSpan;

function titledBlockquote(lead: string | undefined, body: string): string {
  const lines = [...(lead ? [`**${escapeInlineProse(lead)}**`, ''] : []), ...body.split('\n')];
  return lines.map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');
}

const callout: ComponentDisposition = (node, api) => {
  const type = api.attribute(node, 'type');
  const lead =
    api.attribute(node, 'title') ??
    (type ? type.charAt(0).toUpperCase() + type.slice(1) : undefined);
  return titledBlockquote(lead, api.children(node));
};

const accordion: ComponentDisposition = (node, api) => {
  const description = api.attribute(node, 'description');
  const body = [
    ...(description ? [escapeInlineProse(description), ''] : []),
    api.children(node),
  ].join('\n');
  return titledBlockquote(api.attribute(node, 'title'), body);
};

function tabHeadingDepth(tabs: readonly MdxJsxNode[]): number {
  let shallowest = Number.POSITIVE_INFINITY;
  for (const tab of tabs) {
    visit(tab, 'heading', (heading) => {
      shallowest = Math.min(shallowest, heading.depth);
    });
  }
  return Number.isFinite(shallowest) ? Math.max(2, shallowest - 1) : 3;
}

function tabLabels(node: MdxJsxNode): string[] {
  const source = expressionSource(node, 'items');
  if (source === undefined) return [];
  const items = parseAttributeLiteral(source);
  if (!Array.isArray(items)) {
    throw new Error(`<${node.name} items={…}> must be an array of labels.`);
  }
  return items.map(String);
}

function expressionSource(node: MdxJsxNode, name: string): string | undefined {
  const found = node.attributes.find(
    (attribute) => attribute.type === 'mdxJsxAttribute' && attribute.name === name,
  );
  const value = found?.value;
  return typeof value === 'object' && value !== null ? value.value : undefined;
}

function isElement(node: unknown, ...names: string[]): node is MdxJsxNode {
  const typed = node as { type?: string; name?: string };
  return (
    (typed?.type === 'mdxJsxFlowElement' || typed?.type === 'mdxJsxTextElement') &&
    names.includes(typed.name ?? '')
  );
}

function collectItems(
  node: { children?: unknown[] },
  item: string,
  container: string,
): MdxJsxNode[] {
  const found: MdxJsxNode[] = [];
  for (const child of node.children ?? []) {
    if (isElement(child, item)) found.push(child);
    else if (!isElement(child, container) && typeof child === 'object' && child !== null) {
      found.push(...collectItems(child as { children?: unknown[] }, item, container));
    }
  }
  return found;
}

function tabs(...childNames: string[]): ComponentDisposition {
  return (node, api) => {
    const labels = tabLabels(node);
    const panels = childNames.flatMap((name) => collectItems(node, name, node.name ?? ''));
    const depth = '#'.repeat(tabHeadingDepth(panels));
    return panels
      .map((panel, index) => {
        const label =
          api.attribute(panel, 'value') ??
          api.attribute(panel, 'label') ??
          labels[index] ??
          `Tab ${index + 1}`;
        return `${depth} ${escapeInlineProse(label)}\n\n${api.children(panel)}`;
      })
      .join('\n\n');
  };
}

const tabPanel: ComponentDisposition = (node, api) => {
  const label = api.attribute(node, 'value') ?? api.attribute(node, 'label');
  const body = api.children(node);
  return label ? `**${escapeInlineProse(label)}**\n\n${body}` : body;
};

function card(node: MdxJsxNode, api: SerializerApi): string {
  const title = api.attribute(node, 'title') ?? api.attribute(node, 'name') ?? '';
  const href = api.attribute(node, 'href');
  const lead = href
    ? markdownLink(escapeInlineProse(title), api.url(href))
    : `**${escapeInlineProse(title)}**`;
  const body = api.children(node);

  if (/\n[ \t]*\n/.test(body) || /^ {0,3}(```|~~~)/m.test(body)) return `${lead}\n\n${body}`;
  const inline = body.replace(/\s*\n\s*/g, ' ').trim();
  return `- ${lead}${inline ? `: ${inline}` : ''}`;
}

const cards: ComponentDisposition = (node, api) => {
  const rendered = collectItems(node, 'Card', 'Cards').map((child) => card(child, api));
  const everyCardIsALine = rendered.every((entry) => entry.startsWith('- '));
  return rendered.join(everyCardIsALine ? '\n' : '\n\n');
};

function fence(info: string, body: string): string {
  const marker = '`'.repeat(Math.max(2, longestBacktickRun(body)) + 1);
  return `${marker}${info}\n${body}\n${marker}`;
}

const htmlPreview: ComponentDisposition = (node, api) => {
  const encoded = api.attribute(node, 'code');
  if (!encoded)
    throw new Error('<HtmlPreview> carries its block in a `code` attribute, which is missing.');
  const html = Buffer.from(encoded, 'base64').toString('utf8');
  const canonical = (value: string) =>
    value.replace(/\s+/g, '').replaceAll('-', '+').replaceAll('_', '/').replace(/=+$/, '');
  if (canonical(Buffer.from(html, 'utf8').toString('base64')) !== canonical(encoded)) {
    throw new Error('<HtmlPreview> `code` is not valid base64.');
  }
  return fence('html preview', html.replace(/\n$/, ''));
};

const mermaid: ComponentDisposition = (node, api) => {
  const expression = api.expressionAttribute(node, 'chart');
  const chart =
    expression === undefined ? api.attribute(node, 'chart') : parseAttributeLiteral(expression);
  if (typeof chart !== 'string') throw new Error('<Mermaid> needs a `chart` string.');
  return fence('mermaid', chart.replaceAll('\\n', '\n').trim());
};

const typeTable: ComponentDisposition = (node, api) => {
  const source = api.expressionAttribute(node, 'type');
  if (!source) {
    throw new Error(
      api.attribute(node, 'type') === undefined
        ? '<TypeTable> carries its rows in a `type` object, which is missing.'
        : '<TypeTable> `type` must be a braced object expression, not a quoted string.',
    );
  }
  const props = parseAttributeLiteral(source);
  if (typeof props !== 'object' || props === null || Array.isArray(props)) {
    throw new Error('<TypeTable type={…}> must be an object of prop descriptors.');
  }

  const rows = Object.entries(props).map(([name, descriptor]) => {
    if (typeof descriptor !== 'object' || descriptor === null || Array.isArray(descriptor)) {
      throw new Error(`<TypeTable type={…}> descriptor for \`${name}\` must be an object.`);
    }
    const field = (key: string) => {
      const value = descriptor[key];
      if (value === undefined || value === null) return '';
      if (typeof value === 'object') {
        throw new Error(
          `<TypeTable type={…}> \`${name}.${key}\` must be a string, number or boolean.`,
        );
      }
      return String(value);
    };
    return `| ${codeCell(name)} | ${codeCell(field('type'))} | ${
      descriptor.required ? 'yes' : 'no'
    } | ${codeCell(field('default'))} | ${tableCell(field('description'))} |`;
  });

  return [
    '| Prop | Type | Required | Default | Description |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
};

const downloadButton: ComponentDisposition = (_node, api) => {
  const builds = DOWNLOAD_TARGETS.map(
    (target) => `- ${markdownLink(target.label, target.assetUrl)}`,
  );
  return [
    ...builds,
    `- ${markdownLink(WEB_APP_LABEL, api.url(WEB_APP_HREF))}`,
    `- ${markdownLink('All builds and checksums', DOWNLOAD_PAGE_HREF)}`,
  ].join('\n');
};

const layerStack: ComponentDisposition = () =>
  LAYERS.map(
    (layer, index) => `${index + 1}. **${layer.title}** — ${layer.role}. ${layer.desc}`,
  ).join('\n');

const whereToStart: ComponentDisposition = (_node, api) =>
  PATHS.map(
    (path, index) => `${index + 1}. ${markdownLink(path.title, api.url(path.href))} — ${path.desc}`,
  ).join('\n');

const agentIcons: ComponentDisposition = () => AGENTS.map((agent) => agent.name).join(', ');

const iconLabel: ComponentDisposition = (node, api) => {
  const label = api.attribute(node, 'aria-label') ?? api.attribute(node, 'label');
  return label === undefined ? null : escapeInlineProse(label);
};

const image: ComponentDisposition = (node, api) => {
  const src = requiredLiteral(node, api, 'src');
  return markdownLink(escapeInlineProse(api.attribute(node, 'alt') ?? ''), api.url(src), {
    image: true,
  });
};

const anchor: ComponentDisposition = (node, api) => {
  const href = api.attribute(node, 'href');
  const label = api.children(node);
  return href ? markdownLink(label, api.url(href)) : label;
};

function heading(depth: number): ComponentDisposition {
  return (node, api) => `${'#'.repeat(depth)} ${api.children(node)}`;
}

export const DOCS_SERIALIZER_REGISTRY: SerializerRegistry = {
  Accordion: accordion,
  AccordionPreview: accordion,
  AgentIcons: agentIcons,
  Callout: callout,
  CalloutPreview: callout,
  Card: card,
  Cards: cards,
  CopyPrompt: (node, api) => titledBlockquote(undefined, api.children(node)),
  CtaButton: (node, api) => {
    const href = api.attribute(node, 'href');
    const label = escapeInlineProse(api.attribute(node, 'label') ?? href ?? '');
    return href ? markdownLink(label, api.url(href)) : label;
  },
  DownloadButton: downloadButton,
  HtmlPreview: htmlPreview,
  Image: image,
  LayerStack: layerStack,
  McpInstall: (node, api) => {
    const editor = escapeInlineProse(api.attribute(node, 'editor') ?? 'your editor');
    const notes = api.children(node);
    return [
      mcpInstallMarkdown(editor, { url: api.url, link: markdownLink }),
      ...(notes ? ['', notes] : []),
    ].join('\n');
  },
  Mermaid: mermaid,
  Tab: tabPanel,
  TabPreview: tabPanel,
  Tabs: tabs('Tab'),
  TabsPreview: tabs('TabPreview'),
  TypeTable: typeTable,
  VerifyExec: (node, api) =>
    verifyExecMarkdown(escapeInlineProse(api.attribute(node, 'subject') ?? 'The agent')),
  WhereToStart: whereToStart,

  Accordions: 'flatten',
  CalloutContainer: 'flatten',
  CalloutDescription: 'flatten',
  CalloutTitle: 'flatten',
  CodeBlockTab: 'flatten',
  CodeBlockTabs: 'flatten',
  CodeBlockTabsList: 'flatten',
  CodeBlockTabsTrigger: 'flatten',
  ComponentPreview: 'flatten',
  MirrorPreview: 'flatten',
  MirrorSourcePreview: 'flatten',
  Step: 'flatten',
  Steps: 'flatten',

  AudioPreview: 'drop',
  EmbedPreview: 'drop',
  FilePreview: 'drop',
  ImgPreview: 'drop',
  MathPreview: 'drop',
  PdfPreview: 'drop',
  VideoPreview: 'drop',

  Clock: iconLabel,
  Cloud: iconLabel,
  InlineIcon: iconLabel,
  Undo2: iconLabel,

  a: anchor,
  code: (node, api) => code(api.text(node)),
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  h5: heading(5),
  h6: heading(6),
  img: image,
  pre: 'flatten',
  table: 'flatten',
};
