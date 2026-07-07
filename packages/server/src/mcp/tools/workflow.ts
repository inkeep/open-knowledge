/**
 * `workflow` MCP tool — the procedural-guide primers, dispatched on `kind`.
 *
 * Merges the former ingest / research / consolidate / discover tools. Each
 * returns instructional text (a numbered plan), not data; no server connection
 * is needed (discover's Phase 5 link-graph step checks for Hocuspocus itself).
 *
 * Per-`kind` payload:
 *   - `ingest`      → `source` (required): a URL / file / identifier to capture.
 *   - `research`    → `topic`  (required): the question/topic to investigate.
 *   - `consolidate` → `topic`  (required): the topic to fold into a canonical doc.
 *   - `discover`    → (none): extract conventions from an existing repo.
 *   - `wiki`        → (none): generate / refresh a source-grounded wiki of this
 *     codebase (the `codebase-wiki` pack); audience/depth read from the request.
 *
 * `discover` and `wiki` interpolate the resolved `content.dir` into their guide
 * (the others are constants); a missing required arg returns a per-`kind`
 * teaching error.
 */
import { z } from 'zod';
import { buildConsolidateBody } from './consolidate-body.ts';
import { buildDiscoverBody } from './discover-body.ts';
import { buildIngestBody } from './ingest-body.ts';
import { buildResearchBody } from './research-body.ts';
import type { ServerInstance, WorkflowToolDeps } from './shared.ts';
import {
  buildWorkflowHandler,
  outputSchemaWithText,
  previewUrlOutputField,
  ROUTED_CWD_DESCRIPTION,
  resolveProjectConfigContext,
  textPlusStructured,
  textResult,
} from './shared.ts';
import { buildWikiBody } from './wiki-body.ts';

export const DESCRIPTION = [
  'Procedural guides for the three-layer wiki workflow + brownfield onboarding. Returns a numbered plan (instructional text, not data) — you execute it. Dispatches on `kind`:',
  '',
  '- `kind: "ingest"` — capture an external source (URL or local file) into the KB as raw, verbatim reference material (no analysis). Requires `source`.',
  '- `kind: "research"` — gather sources and write provisional findings for a question. Requires `topic`.',
  '- `kind: "consolidate"` — fold provisional material into a canonical article. Requires `topic`.',
  '- `kind: "discover"` — extract conventions from an existing repo (folder frontmatter + templates + link graph). No payload.',
  '- `kind: "wiki"` — generate (or refresh) a navigable, diagram-rich, source-grounded wiki of this codebase into the `wiki/` knowledge base (the `codebase-wiki` pack). No payload; tune via natural-language `audience`/`depth` in your request.',
  '',
  '**Parameters:**',
  '- `kind` — `ingest` | `research` | `consolidate` | `discover` | `wiki`.',
  '- `source` — Required for `ingest`: the URL / file path / identifier to capture.',
  '- `topic` — Required for `research` / `consolidate`: the topic, question, or anchor URL.',
  '- `cwd` (optional) — Project root (see `cwd` description below).',
].join('\n');

export function register(server: ServerInstance, deps: WorkflowToolDeps): void {
  // Reuse the workflow-handler frame machinery (orientation block + previewUrl:
  // null) for the three Karpathy-layer kinds; each reads its own arg name.
  const ingest = buildWorkflowHandler('ingest', deps, 'source', buildIngestBody);
  const research = buildWorkflowHandler('research', deps, 'topic', buildResearchBody);
  const consolidate = buildWorkflowHandler('consolidate', deps, 'topic', buildConsolidateBody);

  server.registerTool(
    'workflow',
    {
      description: DESCRIPTION,
      inputSchema: {
        kind: z
          .enum(['ingest', 'research', 'consolidate', 'discover', 'wiki'])
          .describe('Which workflow guide to return.'),
        source: z
          .string()
          .optional()
          .describe('Required for `kind: "ingest"` — the URL / file / identifier to capture.'),
        topic: z
          .string()
          .optional()
          .describe(
            'Required for `kind: "research"` / `"consolidate"` — the topic / question / anchor URL.',
          ),
        cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
      },
      outputSchema: outputSchemaWithText({
        previewUrl: previewUrlOutputField.describe(
          'Always null — a workflow guide is prose, not a previewable document.',
        ),
      }),
    },
    async (args: {
      kind: 'ingest' | 'research' | 'consolidate' | 'discover' | 'wiki';
      source?: string;
      topic?: string;
      cwd?: string;
    }) => {
      switch (args.kind) {
        case 'ingest':
          if (!args.source) {
            return textResult(
              'Error: workflow({ kind: "ingest" }) requires `source` — the URL / file / identifier to capture. e.g. workflow({ kind: "ingest", source: "https://example.com/spec" }).',
              true,
            );
          }
          return ingest(args);
        case 'research':
          if (!args.topic) {
            return textResult(
              'Error: workflow({ kind: "research" }) requires `topic` — the question or topic to investigate. e.g. workflow({ kind: "research", topic: "rate-limit strategies" }).',
              true,
            );
          }
          return research(args);
        case 'consolidate':
          if (!args.topic) {
            return textResult(
              'Error: workflow({ kind: "consolidate" }) requires `topic` — the topic to fold into a canonical article. e.g. workflow({ kind: "consolidate", topic: "rate-limit strategies" }).',
              true,
            );
          }
          return consolidate(args);
        case 'discover': {
          const context = await resolveProjectConfigContext(deps.resolveCwd, deps.config, args.cwd);
          if (!context.ok) return textResult(`Error: ${context.error}`, true);
          return textPlusStructured(buildDiscoverBody(context.config.content.dir), {
            previewUrl: null,
          });
        }
        case 'wiki': {
          // No-arg kind — mirrors discover's ad-hoc resolve + textPlusStructured
          // pattern (it doesn't use the buildWorkflowHandler factory; the factory
          // serves the three arg-bearing Karpathy kinds — see shared.ts).
          const context = await resolveProjectConfigContext(deps.resolveCwd, deps.config, args.cwd);
          if (!context.ok) return textResult(`Error: ${context.error}`, true);
          return textPlusStructured(buildWikiBody(context.config.content.dir), {
            previewUrl: null,
          });
        }
        default:
          return textResult('Error: unknown workflow kind.', true);
      }
    },
  );
}
