import {
  type ComponentEntryFull,
  getAgentCanonicalDescriptors,
  PREVIEW_EMBED_STARTERS,
  PREVIEW_THEME_TOKENS,
  previewEmbedFence,
  projectFull,
} from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import type { ConfigOrResolver, ServerInstance } from './shared.ts';
import { outputSchemaWithText, ROUTED_CWD_DESCRIPTION, textPlusStructured } from './shared.ts';

const DESCRIPTION = [
  '[Operates on registry data; no running OK server required] Return the OK authoring palette so a generated document reads as one coherent, themed artifact.',
  '',
  'Three sections:',
  '- `components` — the **markdown-native forms** OK auto-promotes into themed canonical components at parse time. Write `> [!NOTE]` (not `<Callout>`), `<details>` (not `<Accordion>`), ` ```mermaid `, `$x$`. Each entry carries a copy-ready `example` + `guidance`.',
  '- `embedPatterns` — copy-ready ` ```html preview ` starters (chart, stat cards, custom SVG, interactive control) already wired to the theme tokens, so an embed tracks light/dark with no hand-picked colors.',
  '- `tokens` — the CSS custom properties injected into every preview iframe; reference them as `var(--chart-1)`, `var(--foreground)`, … inside an `html preview` embed. **Inside SVG, route theme tokens through `style="..."` rather than presentation attributes** — `<circle style="fill: var(--chart-1)">` works; `<circle fill="var(--chart-1)">` silently falls back to black in Safari / older Chromium because CSS `var()` is not a valid SVG `<paint>` value per the W3C spec.',
  '',
  'External resources load directly: the preview iframe has open network access, so an embed can load external stylesheets, `fetch` live data, or pull map tiles / remote images / web fonts over `https:`. The iframe is a sandboxed null-origin frame — an embed can reach the network but never the knowledge base, cookies, or auth.',
  '',
  'Pass `components: [ids]` to ALSO get the full JSX-form prop schema for specific canonicals (e.g. `palette({ components: ["Callout", "Tabs"] })`) — merged from the former `get_components`.',
  '',
  '**Parameters:**',
  '- `components` (optional) — Canonical ids to expand to full JSX-form detail (max 32). Case-sensitive (`Callout` not `callout`). Returns `componentDetails` + `notFound`.',
  '- `cwd` (optional) — Project root (see `cwd` description below).',
].join('\n');

interface GetAuthoringPaletteDeps {
  resolveCwd: (explicit?: string) => Promise<string>;
  config: ConfigOrResolver;
}

const InputSchema = {
  components: z
    .array(z.string().min(1))
    .max(32)
    .optional()
    .describe(
      'Canonical ids to expand to full JSX-form detail (max 32, case-sensitive). Returns `componentDetails` + `notFound`.',
    ),
  cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
} as const;

const OutputSchema = outputSchemaWithText({
  version: z.literal(1).describe('Schema version stamp — bump for breaking shape changes.'),
  components: z
    .array(
      z.object({
        id: z.string(),
        displayName: z.string(),
        description: z.string(),
        authoring: z
          .enum(['markdown', 'jsx'])
          .describe(
            '`markdown` — write the markdown-native form OK auto-promotes; `jsx` — write the JSX tag directly (no markdown-native form exists).',
          ),
        example: z.string().describe('Copy-ready source for the authoring form.'),
        guidance: z.string().describe('One line on when / how to use this construct.'),
      }),
    )
    .describe('Canonical authoring constructs, keyed by the form an agent should write.'),
  embedPatterns: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        description: z.string(),
        snippet: z.string().describe('A complete, theme-wired ```html preview fenced block.'),
      }),
    )
    .describe('Copy-ready themed `html preview` starters.'),
  tokens: z
    .array(
      z.object({
        name: z.string().describe('CSS custom-property name, e.g. `--chart-1`.'),
        light: z.string(),
        dark: z.string(),
      }),
    )
    .describe('Theme tokens injected into every preview iframe — reference with `var(--name)`.'),
  componentDetails: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe('Full JSX-form prop schema for the requested `components` ids (when provided).'),
  notFound: z
    .array(z.string())
    .optional()
    .describe('Requested `components` ids that did not match any canonical.'),
});

interface AuthoringFormSeed {
  id: string;
  registryName?: string;
  fallbackDisplayName: string;
  description: string;
  authoring: 'markdown' | 'jsx';
  example: string;
  guidance: string;
}

const AUTHORING_FORMS: readonly AuthoringFormSeed[] = [
  {
    id: 'Callout',
    registryName: 'Callout',
    fallbackDisplayName: 'Callout',
    description: 'Alert / admonition box in one of 15 themed type variants.',
    authoring: 'markdown',
    example: '> [!NOTE]\n> Body text. Swap NOTE for TIP, IMPORTANT, WARNING, CAUTION, …',
    guidance:
      'Write the GFM alert form — OK auto-promotes it to a themed Callout. 15 types; append `+` / `-` (e.g. `> [!NOTE]+`) to make it foldable.',
  },
  {
    id: 'Accordion',
    registryName: 'Accordion',
    fallbackDisplayName: 'Accordion',
    description: 'Collapsible section with a clickable summary.',
    authoring: 'markdown',
    example: '<details>\n<summary>Section title</summary>\n\nHidden body content.\n\n</details>',
    guidance: 'Write a plain `<details>` — OK auto-promotes it to a themed Accordion.',
  },
  {
    id: 'Mermaid',
    fallbackDisplayName: 'Mermaid diagram',
    description: 'Flowchart / sequence / class / state / ER / gantt / pie diagram.',
    authoring: 'markdown',
    example:
      '```mermaid\ngraph LR\n  A["Start (label with punctuation)"] --> B[End]\n```\n\n```mermaid\nsequenceDiagram\n    A->>B: request queued #59; retried\n    B-->>A: done\n```',
    guidance:
      'Write a ` ```mermaid ` fenced block — it renders as a themed diagram. Sharp edge 1: raw `;` and `#` END message/label text in sequence-family grammars — use commas, or the entity escapes `#59;` / `#35;`. Sharp edge 2: quote flowchart labels containing punctuation (`A["label (with) punctuation"]`). Feedback: parse failures come back as `warnings` entries (kind `mermaid-parse-error`) on write/edit — fix the fence and re-edit.',
  },
  {
    id: 'Math',
    registryName: 'Math',
    fallbackDisplayName: 'Math',
    description: 'LaTeX math, rendered with KaTeX.',
    authoring: 'markdown',
    example: 'Inline: $E = mc^2$\n\nBlock:\n\n$$\n\\int_0^1 x^2 \\, dx\n$$',
    guidance: 'Write LaTeX in `$…$` (inline) or `$$…$$` (block) — OK auto-promotes it to Math.',
  },
  {
    id: 'wiki-embed',
    fallbackDisplayName: 'Wiki embed',
    description: 'Inline another document or an asset by name.',
    authoring: 'markdown',
    example: '![[document-name]]\n\n![[diagram.png]]',
    guidance: 'Write a `![[file]]` wiki-embed to inline another doc or an uploaded asset.',
  },
  {
    id: 'Tabs',
    registryName: 'Tabs',
    fallbackDisplayName: 'Tabs',
    description: 'Tabbed panels — a pill strip with one panel visible at a time.',
    authoring: 'jsx',
    example:
      '<Tabs>\n  <Tab label="First">First panel content.</Tab>\n  <Tab label="Second">Second panel content.</Tab>\n</Tabs>',
    guidance: 'Tabs is the one canonical with no markdown-native form — write the JSX directly.',
  },
];

interface AuthoringComponent {
  id: string;
  displayName: string;
  description: string;
  authoring: 'markdown' | 'jsx';
  example: string;
  guidance: string;
}

function buildComponents(): AuthoringComponent[] {
  const byName = new Map(getAgentCanonicalDescriptors().map((d) => [d.name, d]));
  return AUTHORING_FORMS.map((form) => {
    const descriptor = form.registryName ? byName.get(form.registryName) : undefined;
    return {
      id: form.id,
      displayName: descriptor?.displayName ?? descriptor?.name ?? form.fallbackDisplayName,
      description: form.description,
      authoring: form.authoring,
      example: form.example,
      guidance: form.guidance,
    };
  });
}

export function register(server: ServerInstance, _deps: GetAuthoringPaletteDeps): void {
  server.registerTool(
    'palette',
    {
      description: DESCRIPTION,
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args: { components?: string[]; cwd?: string }) => {
      void args.cwd;
      const payload: {
        version: 1;
        components: ReturnType<typeof buildComponents>;
        embedPatterns: Array<{ id: string; title: string; description: string; snippet: string }>;
        tokens: Array<{ name: string; light: string; dark: string }>;
        componentDetails?: ComponentEntryFull[];
        notFound?: string[];
      } = {
        version: 1,
        components: buildComponents(),
        embedPatterns: PREVIEW_EMBED_STARTERS.map((s) => ({
          id: s.id,
          title: s.title,
          description: s.description,
          snippet: previewEmbedFence(s),
        })),
        tokens: PREVIEW_THEME_TOKENS.map((t) => ({ name: t.name, light: t.light, dark: t.dark })),
      };
      if (args.components && args.components.length > 0) {
        const byId = new Map(getAgentCanonicalDescriptors().map((d) => [d.name, d]));
        const details: ComponentEntryFull[] = [];
        const notFound: string[] = [];
        const seen = new Set<string>();
        for (const id of args.components) {
          if (seen.has(id)) continue;
          seen.add(id);
          const descriptor = byId.get(id);
          if (descriptor === undefined) {
            notFound.push(id);
            continue;
          }
          details.push(projectFull(descriptor));
        }
        payload.componentDetails = details;
        payload.notFound = notFound;
      }
      return textPlusStructured(JSON.stringify(payload, null, 2), payload);
    },
  );
}
