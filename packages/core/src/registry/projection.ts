/**
 * Agent-facing component projection — surfaces the canonical authoring-construct
 * registry for the OK MCP `palette` tool (`components` projection) and for the
 * inline inventory embedded in `write` / `edit` tool descriptions.
 *
 * Single projection function backs both surfaces; the lite shape (first 4
 * fields) feeds the tool-description inventory, the full shape feeds
 * `palette({ components })`. Examples are synthesized from descriptor metadata via the
 * existing `propToMdxJsxAttribute` encoder + `mdast-util-to-markdown` (with the
 * mdx-jsx extension) — drift-free, production-matching, no PM-shape / Y.Doc
 * dependency at projection time.
 *
 * Filter: `surface === 'canonical' && name !== '*'`. The wildcard `'*'`
 * descriptor is intentionally omitted — agents discover the wildcard fallback
 * via SKILL.md prose ("any `<TagName>` renders as raw MDX"), not as a
 * first-class manifest entry. The slash-menu filter is a documented superset
 * (the same filter PLUS `!SLASH_HIDDEN_CANONICALS.has(name)` — `File` and
 * `Tab` are hidden from humans but exposed to agents).
 */

import type { Nodes as MdastNodes, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { MdxJsxAttribute, MdxJsxFlowElement } from 'mdast-util-mdx';
import { mdxFromMarkdown, mdxToMarkdown } from 'mdast-util-mdx';
import { toMarkdown } from 'mdast-util-to-markdown';
import { mdx } from 'micromark-extension-mdx';
import { propToMdxJsxAttribute } from '../markdown/serialize-helpers.ts';
import { builtInComponents } from './built-ins.ts';
import type { JsxComponentMeta, PropDef } from './types.ts';

// Module-level singletons mirror the pattern in `remark-mdx-agnostic.ts` —
// reuse a single extension instance across every example synthesis.
const MICROMARK_MDX_EXT = mdx();
const FROM_MARKDOWN_MDX_EXT = mdxFromMarkdown();
const TO_MARKDOWN_MDX_EXT = mdxToMarkdown();

/**
 * Canonical kind taxonomy for agent-facing entries.
 *
 * - `jsx-block` — block-form JSX with children (`<Callout>…</Callout>`).
 * - `jsx-void` — self-closing JSX with no body (`<img src="" />`).
 * - `fence` — fenced code block (`MermaidFence`, the one fence-kind canonical).
 */
export type ComponentKind = 'jsx-block' | 'jsx-void' | 'fence';

/** Lite per-entry shape — what the write-tool-description inventory carries. */
export interface ComponentEntryLite {
  id: string;
  displayName: string;
  description: string;
  kind: ComponentKind;
}

/** Form-aware per-param shape — agents read this as a form definition to fill. */
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

/** Full per-entry shape — what `palette({ components })` returns. */
export interface ComponentEntryFull extends ComponentEntryLite {
  example: string;
  params: ComponentParam[];
}

const PLACEHOLDER_BODY = 'Body content here.';
const PLACEHOLDER_MERMAID_FENCE_BODY = 'graph LR\n  A --> B';

/**
 * Broad canonical filter — every `surface: 'canonical'` descriptor except the
 * wildcard. Used by tests and by the slash-menu's filter (which subtracts a
 * UX hide-set on top). Includes fence-kind canonicals like `MermaidFence`;
 * for the agent-facing projection (inventory + `palette`), use
 * `getAgentCanonicalDescriptors()` instead — it additionally excludes
 * fence-kind so agents aren't presented with non-JSX shapes as if they were
 * components.
 */
export function getCanonicalDescriptors(): JsxComponentMeta[] {
  return builtInComponents.filter((d) => d.surface === 'canonical' && d.name !== '*');
}

/**
 * Agent-facing canonical filter — `surface: 'canonical'`, not wildcard, and
 * not fence-kind. Fence-kind canonicals (today: `MermaidFence`) are excluded
 * because there is no JSX authoring form for them — the canonical shape is a
 * fenced code block (```mermaid ... ```), which every agent already authors
 * via baseline markdown. Listing fence-kind in the inventory makes agents
 * guess at a JSX tag that doesn't exist (e.g. `<Mermaid />`). The descriptor
 * stays in the registry because it's load-bearing for the parse pipeline.
 */
export function getAgentCanonicalDescriptors(): JsxComponentMeta[] {
  return getCanonicalDescriptors().filter((d) => resolveKind(d) !== 'fence');
}

/**
 * Resolve the kind discriminator for a descriptor.
 *
 * Today `MermaidFence` is the only fence-kind canonical, so the check is
 * name-based. There is no structural `fenceKind?: boolean` on
 * `JsxComponentMetaBase` because adding a new fence-kind canonical is rare
 * enough that an explicit branch here is preferable to a property the
 * descriptor authors would have to remember to set. If a second fence-kind
 * canonical is added, extend this branch (and the divergence-set assertion
 * in projection.test.ts) at the same time.
 */
function resolveKind(descriptor: JsxComponentMeta): ComponentKind {
  if (descriptor.name === 'MermaidFence') return 'fence';
  if (descriptor.hasChildren) return 'jsx-block';
  return 'jsx-void';
}

/** Lite projection — id / displayName / description / kind. */
export function projectLite(descriptor: JsxComponentMeta): ComponentEntryLite {
  return {
    id: descriptor.name,
    displayName: descriptor.displayName ?? descriptor.name,
    description: descriptor.description ?? '',
    kind: resolveKind(descriptor),
  };
}

/**
 * Resolve the encoded value the example should display for a given prop.
 *
 * Priority:
 *   1. declared `defaultValue` if present (incl. `''` and `false`)
 *   2. first `enumValue` for enum-typed props
 *   3. type-empty: `''` for string, `0` for number, `false` for boolean
 *
 * Returns `undefined` for props that should be omitted from the example —
 * reactnode props are body content (not attributes), and hidden props are
 * filtered entirely from the agent surface.
 */
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

/**
 * Should this prop's attribute be emitted into the example, given the encoded
 * value? Mirrors the production-emit shape from `reconstructAttrs` so the
 * example matches what an agent would actually need to write:
 *
 *   - `omitOnDefault: true` + value === defaultValue → omit (cleaner example;
 *     matches the disk shape after PropPanel-driven default-emission strip).
 *   - optional string prop with no declared default, value === '' → omit
 *     (empty-attr drift is noise; required string props with empty defaults
 *     like `<img alt="">` are preserved — `required: true` excludes them).
 */
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

/**
 * Build the children mdast for a `hasChildren: true` descriptor.
 *
 * The descriptor's optional `exampleBody` is treated as raw markdown/MDX
 * source so authors can embed nested JSX (e.g. `Tabs` needs `<Tab>` children).
 * Falls back to a plain paragraph with the placeholder body. Empty-string
 * `exampleBody` still falls back — the placeholder is what gives the agent a
 * concrete shape.
 */
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

/**
 * Synthesize the source-form example for a single canonical descriptor.
 * Returns the literal authoring shape (copy-pasteable) — this is the
 * load-bearing payload agents use to write canonical-shaped content.
 */
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

/** Project one descriptor's params to the agent-facing param shape. */
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

/** Full projection — lite + example + params. */
export function projectFull(descriptor: JsxComponentMeta): ComponentEntryFull {
  return {
    ...projectLite(descriptor),
    example: synthesizeExample(descriptor),
    params: projectParams(descriptor),
  };
}

/**
 * Render the inline inventory text that gets baked into the JSON-schema
 * `description` of `write` and `edit`. The footer leads with
 * the canonical-preference framing and lists every canonical with its kind +
 * description so agents can pick the right one without a separate listing call.
 *
 * Computed once at server boot (registry is module-init pure-data). When the
 * registry changes, server restart applies the new text.
 */
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
