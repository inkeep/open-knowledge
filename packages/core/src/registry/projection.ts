
import type { Nodes as MdastNodes, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { MdxJsxAttribute, MdxJsxFlowElement } from 'mdast-util-mdx';
import { mdxFromMarkdown, mdxToMarkdown } from 'mdast-util-mdx';
import { toMarkdown } from 'mdast-util-to-markdown';
import { mdx } from 'micromark-extension-mdx';
import { propToMdxJsxAttribute } from '../markdown/serialize-helpers.ts';
import { builtInComponents } from './built-ins.ts';
import type { JsxComponentMeta, PropDef } from './types.ts';

const MICROMARK_MDX_EXT = mdx();
const FROM_MARKDOWN_MDX_EXT = mdxFromMarkdown();
const TO_MARKDOWN_MDX_EXT = mdxToMarkdown();

export type ComponentKind = 'jsx-block' | 'jsx-void' | 'fence';

export interface ComponentEntryLite {
  id: string;
  displayName: string;
  description: string;
  kind: ComponentKind;
}

export interface ComponentParam {
  name: string;
  type: 'string' | 'boolean' | 'number' | 'enum' | 'reactnode';
  values?: readonly string[];
  required: boolean;
  defaultValue?: string | boolean | number;
  description?: string;
  omitOnDefault?: true;
  advanced?: true;
  language?: 'mermaid' | 'latex' | 'html' | 'json' | 'yaml' | 'javascript' | 'markdown';
  accept?: readonly string[];
}

export interface ComponentEntryFull extends ComponentEntryLite {
  example: string;
  params: ComponentParam[];
}

const PLACEHOLDER_BODY = 'Body content here.';
const PLACEHOLDER_MERMAID_FENCE_BODY = 'graph LR\n  A --> B';

export function getCanonicalDescriptors(): JsxComponentMeta[] {
  return builtInComponents.filter((d) => d.surface === 'canonical' && d.name !== '*');
}

export function getAgentCanonicalDescriptors(): JsxComponentMeta[] {
  return getCanonicalDescriptors().filter((d) => resolveKind(d) !== 'fence');
}

function resolveKind(descriptor: JsxComponentMeta): ComponentKind {
  if (descriptor.name === 'MermaidFence') return 'fence';
  if (descriptor.hasChildren) return 'jsx-block';
  return 'jsx-void';
}

export function projectLite(descriptor: JsxComponentMeta): ComponentEntryLite {
  return {
    id: descriptor.name,
    displayName: descriptor.displayName ?? descriptor.name,
    description: descriptor.description ?? '',
    kind: resolveKind(descriptor),
  };
}

function exampleValueFor(prop: PropDef): unknown {
  if (prop.hidden === true) return undefined;
  if (prop.type === 'reactnode') return undefined;
  if ('defaultValue' in prop && prop.defaultValue !== undefined) return prop.defaultValue;
  if (prop.type === 'enum') return prop.enumValues[0];
  if (prop.type === 'string') return '';
  if (prop.type === 'number') return 0;
  if (prop.type === 'boolean') return false;
  return undefined;
}

function shouldEmitProp(prop: PropDef, value: unknown): boolean {
  if (
    prop.omitOnDefault === true &&
    'defaultValue' in prop &&
    Object.is(prop.defaultValue, value)
  ) {
    return false;
  }
  if (
    prop.type === 'string' &&
    prop.required === false &&
    prop.defaultValue === undefined &&
    value === ''
  ) {
    return false;
  }
  return true;
}

function buildAttributes(descriptor: JsxComponentMeta): MdxJsxAttribute[] {
  const attrs: MdxJsxAttribute[] = [];
  for (const prop of descriptor.props) {
    const value = exampleValueFor(prop);
    if (value === undefined) continue;
    if (!shouldEmitProp(prop, value)) continue;
    attrs.push(propToMdxJsxAttribute(prop.name, value));
  }
  return attrs;
}

function buildBodyChildren(descriptor: JsxComponentMeta): MdxJsxFlowElement['children'] {
  const source =
    descriptor.exampleBody && descriptor.exampleBody.trim().length > 0
      ? descriptor.exampleBody
      : PLACEHOLDER_BODY;
  const tree = fromMarkdown(source, {
    extensions: [MICROMARK_MDX_EXT],
    mdastExtensions: [FROM_MARKDOWN_MDX_EXT],
  });
  return tree.children as MdxJsxFlowElement['children'];
}

function synthesizeExample(descriptor: JsxComponentMeta): string {
  const kind = resolveKind(descriptor);
  let node: MdastNodes;
  if (kind === 'fence') {
    const body =
      descriptor.exampleBody && descriptor.exampleBody.trim().length > 0
        ? descriptor.exampleBody
        : PLACEHOLDER_MERMAID_FENCE_BODY;
    node = { type: 'code', lang: 'mermaid', meta: null, value: body };
  } else {
    const attributes = buildAttributes(descriptor);
    const children: MdxJsxFlowElement['children'] =
      kind === 'jsx-block' ? buildBodyChildren(descriptor) : [];
    node = {
      type: 'mdxJsxFlowElement',
      name: descriptor.name,
      attributes,
      children,
    };
  }
  const tree: { type: 'root'; children: RootContent[] } = {
    type: 'root',
    children: [node as RootContent],
  };
  return toMarkdown(tree, { extensions: [TO_MARKDOWN_MDX_EXT] }).trimEnd();
}

function projectParams(descriptor: JsxComponentMeta): ComponentParam[] {
  const out: ComponentParam[] = [];
  for (const prop of descriptor.props) {
    if (prop.hidden === true) continue;
    const entry: ComponentParam = {
      name: prop.name,
      type: prop.type,
      required: prop.required,
    };
    if (prop.description !== undefined) entry.description = prop.description;
    if (prop.advanced === true) entry.advanced = true;
    if (prop.omitOnDefault === true) entry.omitOnDefault = true;
    if (prop.type === 'enum') {
      entry.values = prop.enumValues;
      if (prop.defaultValue !== undefined) entry.defaultValue = prop.defaultValue;
    }
    if (prop.type === 'string') {
      if (prop.defaultValue !== undefined) entry.defaultValue = prop.defaultValue;
      if (prop.language !== undefined) entry.language = prop.language;
      if (prop.accept !== undefined) entry.accept = prop.accept;
    }
    if (prop.type === 'boolean' && prop.defaultValue !== undefined)
      entry.defaultValue = prop.defaultValue;
    if (prop.type === 'number' && prop.defaultValue !== undefined)
      entry.defaultValue = prop.defaultValue;
    out.push(entry);
  }
  return out;
}

export function projectFull(descriptor: JsxComponentMeta): ComponentEntryFull {
  return {
    ...projectLite(descriptor),
    example: synthesizeExample(descriptor),
    params: projectParams(descriptor),
  };
}

export function renderInventoryFooter(): string {
  const lite = getAgentCanonicalDescriptors().map(projectLite);
  const lines = lite.map((entry) => `- \`${entry.id}\` (${entry.kind}) — ${entry.description}`);
  return [
    '',
    '**Custom canonical components.** OK `.md` / `.mdx` supports the JSX components below — use whichever is semantically useful in any part of the doc. For full source syntax + parameter schemas, call `palette({ components: [ids] })` with the ids you want to use. Fenced code blocks render naturally and don\'t need a fetch — including ` ```mermaid ` for diagrams (mermaid label text has sharp edges — `palette({ components: ["Mermaid"] })` lists them; parse failures come back as `warnings` entries on write/edit) and ` ```html preview ` for interactive HTML/JS/CSS pages (the fence info-string `preview` token renders the block as a live iframe; works for `html` / `htm` / `xml`; optional `h=` / `w=` tokens set size, e.g. ` ```html preview h=400px `). Use ` ```html preview ` whenever you want anything interactive or JS-powered (charts, demos, calculators, animations) — just author the standalone HTML page in the fence. Call `palette` for the markdown-native component forms (write `> [!NOTE]`, not `<Callout>`), copy-ready themed `html preview` starters, and the theme tokens (`var(--chart-1)`, `var(--foreground)`, …) an embed should reference so it tracks the reader\'s light/dark theme. Arbitrary `<TagName>` JSX falls through as raw MDX when no canonical fits.',
    '',
    ...lines,
  ].join('\n');
}
