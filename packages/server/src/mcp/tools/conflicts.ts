/**
 * `conflicts` MCP tool — read GitHub-sync merge conflicts.
 *
 * - `kind: "list"`    → enumerate every doc tracked in a merge-conflict state
 *   (`GET /api/sync/conflicts`).
 * - `kind: "content"` → fetch the three merge stages (base / ours / theirs)
 *   plus lifecycle status and the conflict `shape` for one `file`
 *   (`GET /api/sync/conflict-content?file=<path>&source=ytext`).
 *
 * Merges the former `list_conflicts` + `get_conflict_content` (both reads;
 * `resolve_conflict` stays a separate write). Keys on `file` (WITH extension)
 * — the ONE documented exception to the `document`/`path` vocabulary,
 * because git stages key on the exact on-disk path and sibling `.md`/`.mdx`
 * can both conflict. The output's conflict-shape field is `shape` so it
 * doesn't collide with the input `kind`.
 */
import { z } from 'zod';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  HOCUSPOCUS_NOT_RUNNING_ERROR,
  httpGet,
  looseObjectArray,
  outputSchemaWithText,
  ROUTED_CWD_DESCRIPTION,
  resolveProjectServerContext,
  textPlusStructured,
  textResult,
} from './shared.ts';

const DESCRIPTION = [
  '[Requires: Hocuspocus server] Read GitHub-sync merge conflicts. Dispatches on `kind`:',
  '',
  '- `kind: "list"` — enumerate every doc currently tracked in a merge-conflict state. Returns `{ list: [{ file, detectedAt, ... }] }` (empty when none). The entry point to the resolve flow.',
  '- `kind: "content"` — fetch the three merge stages for one `file`. Returns `{ content: { file, base, ours, theirs, shape, lifecycleStatus } }`. `ours` reflects the live Y.Text (what the human sees) when the doc is loaded server-side.',
  '',
  '**Parameters:**',
  '- `kind` — `list` | `content`.',
  '- `file` — Required for `kind: "content"`. Relative path WITH the `.md`/`.mdx` extension (e.g. `notes/sso.md`) — git stages key on the exact path, so do NOT strip the extension.',
  '',
  'The `shape` field discriminates the conflict: `both-modified` (both sides edited), `delete-modify` (you deleted, they edited — `ours` empty), or `modify-delete` (you edited, they deleted — `theirs` empty). Use it to pick the `resolve_conflict` strategy.',
].join('\n');

interface ConflictsDeps {
  serverUrl: ServerUrlOrResolver;
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
}

export function register(server: ServerInstance, deps: ConflictsDeps): void {
  server.registerTool(
    'conflicts',
    {
      description: DESCRIPTION,
      inputSchema: {
        kind: z
          .enum(['list', 'content'])
          .describe("`list` enumerates tracked conflicts; `content` fetches one file's stages."),
        file: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Required when `kind: "content"`. Conflicted file WITH extension (e.g. `notes/sso.md`) — git stages key on the exact path, so keep the extension (DD2).',
          ),
        cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
      },
      // Result nests under the `kind` you asked for (exactly one is present):
      // `list` → the tracked-conflict array; `content` → the merge stages.
      outputSchema: outputSchemaWithText({
        list: looseObjectArray
          .optional()
          .describe('`kind: "list"` — every tracked conflict (`{ file, detectedAt, ... }`).'),
        content: z
          .object({
            file: z.string().describe('The conflicted file.'),
            base: z.string().describe('Merge-base stage content.'),
            ours: z.string().describe('Our stage (live Y.Text when loaded server-side).'),
            theirs: z.string().describe('Their stage content.'),
            shape: z
              .enum(['both-modified', 'delete-modify', 'modify-delete'])
              .describe('Conflict shape — pick the `resolve_conflict` strategy from it.'),
            lifecycleStatus: z.string().nullable().describe("The doc's lifecycle status, or null."),
          })
          .optional()
          .describe('`kind: "content"` — the three merge stages + shape + lifecycle.'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args: { kind: 'list' | 'content'; file?: string; cwd?: string }) => {
      const context = await resolveProjectServerContext(
        deps.resolveCwd,
        deps.config,
        deps.serverUrl,
        args.cwd,
      );
      if (!context.ok) return textResult(`Error: ${context.error}`, true);
      const { url } = context;
      if (!url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);

      if (args.kind === 'content') {
        if (!args.file) {
          return textResult(
            'Error: `kind: "content"` requires `file` — the conflicted file WITH extension, e.g. conflicts({ kind: "content", file: "notes/sso.md" }).',
            true,
          );
        }
        const query = `?file=${encodeURIComponent(args.file)}&source=ytext`;
        const result = await httpGet(url, `/api/sync/conflict-content${query}`);
        if (!result.ok) {
          const error = result.error as string;
          const detail = typeof result.detail === 'string' ? result.detail : undefined;
          return textResult(`Error: ${detail ? `${error} — ${detail}` : error}`, true);
        }
        const rec = result as Record<string, unknown>;
        const file = typeof rec.file === 'string' ? rec.file : args.file;
        const base = typeof rec.base === 'string' ? rec.base : '';
        const ours = typeof rec.ours === 'string' ? rec.ours : '';
        const theirs = typeof rec.theirs === 'string' ? rec.theirs : '';
        // the route emits the conflict-shape as `kind`; surface it as
        // `shape` so it does not collide with this tool's input `kind`. Fall
        // back to `both-modified` for stale-server safety.
        const shape: 'both-modified' | 'delete-modify' | 'modify-delete' =
          rec.kind === 'delete-modify' || rec.kind === 'modify-delete' ? rec.kind : 'both-modified';
        const lifecycleStatus =
          typeof rec.lifecycleStatus === 'string' ? rec.lifecycleStatus : null;
        const lifecycleSuffix = lifecycleStatus ? ` (lifecycle: ${lifecycleStatus})` : '';
        const text = `Conflict stages for ${file} (shape: ${shape})${lifecycleSuffix}:\n--- base ---\n${base}\n--- ours ---\n${ours}\n--- theirs ---\n${theirs}`;
        // Nested under the `content` kind key (mirrors the input `kind`).
        return textPlusStructured(text, {
          content: { file, base, ours, theirs, shape, lifecycleStatus },
        });
      }

      // kind: 'list'
      const result = await httpGet(url, '/api/sync/conflicts');
      if (!result.ok) {
        // Text-only error: emitting `{ list: [] }` here would be byte-identical
        // to a successful "no conflicts" response, so an agent pattern-matching
        // on `structuredContent.list.length === 0` without checking `isError`
        // would read a server failure as "no conflicts".
        return textResult(`Error: ${result.error as string}`, true);
      }
      const rawConflicts = (result as { conflicts?: unknown }).conflicts;
      const conflicts = Array.isArray(rawConflicts) ? rawConflicts : [];
      const text =
        conflicts.length === 0
          ? 'No conflicts tracked.'
          : `Tracked conflicts (${conflicts.length}):\n${conflicts
              .map((row) => {
                const file =
                  row && typeof row === 'object' && 'file' in row
                    ? String((row as Record<string, unknown>).file ?? '')
                    : '';
                return `- ${file}`;
              })
              .join('\n')}`;
      return textPlusStructured(text, { list: conflicts });
    },
  );
}
