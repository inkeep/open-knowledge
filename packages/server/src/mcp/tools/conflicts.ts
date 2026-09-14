import { ConflictEntrySchema } from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  HOCUSPOCUS_NOT_RUNNING_ERROR,
  httpGet,
  outputSchemaWithText,
  ROUTED_CWD_DESCRIPTION,
  resolveProjectServerContext,
  textPlusStructured,
  textResult,
} from './shared.ts';

const DESCRIPTION = [
  '[Requires: Hocuspocus server] Read tracked conflicts. Dispatches on `kind`:',
  '',
  '- `kind: "list"` enumerates every file currently tracked as conflicted. Returns `{ list: [{ file, detectedAt, conflict, reason?, conflictKind?, docName }] }` (empty when none). The entry point to the resolve flow.',
  '- `kind: "content"` fetches the three stages for one `file`. Returns `{ content: { file, base, ours, theirs, shape, conflict, reason?, conflictKind?, resolutionOptions } }`. `ours` is the live Y.Text when the doc is loaded server-side and marker-free, else the stage pinned when the conflict was detected; for `reason: "stale-external-write"` it is the protected acknowledged content and `theirs` the rejected older save. On a `reconcile` conflict, `resolve_conflict` with `mine` uses the latest marker-free live Y.Text, falling back to the captured editor stage when the document is unloaded or contains markers. To keep exactly the bytes reviewed here, send them back as `content`. Returns 404 (`urn:ok:error:no-conflict-tracked`) when no conflict is tracked for that `file`; re-read the list before retrying.',
  '',
  '**Parameters:**',
  '- `kind` — `list` | `content`.',
  '- `file` — Required for `kind: "content"`. Relative path WITH the `.md`/`.mdx` extension (e.g. `notes/sso.md`) — git stages key on the exact path, so do NOT strip the extension.',
  '',
  "`conflict` names where the conflict came from: `merge-native` (a git merge left unmerged stages), `working-tree` (a pull-only overlay collision pinned to an origin blob), or `reconcile` (OK's own merge of editor and disk, including local stale-save protection); `reason` refines a `reconcile` conflict, and the compatibility `conflictKind` field is `stale-external-write` for that reason and `git` otherwise. `resolutionOptions` lists the strategies that apply to THIS conflict: a `reconcile` conflict whose `theirs` side is raw marker text does not offer `theirs`, and `refused-too-large` offers only `mine`, `theirs`, and `delete`.",
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
      outputSchema: outputSchemaWithText({
        list: z
          .array(ConflictEntrySchema)
          .optional()
          .describe('`kind: "list"` returns every tracked conflict.'),
        content: z
          .object({
            file: z.string().describe('The conflicted file.'),
            base: z.string().describe('Merge-base stage content.'),
            ours: z.string().describe('Our stage (live Y.Text when loaded server-side).'),
            theirs: z.string().describe('Their stage content.'),
            shape: z
              .enum(['both-modified', 'delete-modify', 'modify-delete'])
              .describe('Conflict shape — pick the `resolve_conflict` strategy from it.'),
            conflict: z
              .enum(['merge-native', 'working-tree', 'reconcile'])
              .describe('Where this conflict came from.'),
            reason: z.string().optional().describe('Refines a `reconcile` conflict.'),
            conflictKind: z
              .enum(['git', 'stale-external-write'])
              .optional()
              .describe('Compatibility classification for Git and protected stale-save conflicts.'),
            resolutionOptions: z
              .array(z.enum(['mine', 'theirs', 'content', 'delete']))
              .describe('The strategies that apply to this conflict.'),
          })
          .optional()
          .describe(
            '`kind: "content"` returns the three stages plus shape, conflict kind and options.',
          ),
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
        const shape: 'both-modified' | 'delete-modify' | 'modify-delete' =
          rec.kind === 'delete-modify' || rec.kind === 'modify-delete' ? rec.kind : 'both-modified';
        const conflict: 'merge-native' | 'working-tree' | 'reconcile' =
          rec.conflict === 'working-tree' || rec.conflict === 'reconcile'
            ? rec.conflict
            : 'merge-native';
        const reason = typeof rec.reason === 'string' ? rec.reason : undefined;
        const conflictKind =
          rec.conflictKind === 'stale-external-write' ? 'stale-external-write' : 'git';
        const resolutionOptions = Array.isArray(rec.resolutionOptions)
          ? (rec.resolutionOptions as Array<'mine' | 'theirs' | 'content' | 'delete'>)
          : (['mine', 'theirs', 'content', 'delete'] as const).slice();
        const reasonSuffix = reason ? `, reason: ${reason}` : '';
        const text = `Conflict stages for ${file} (shape: ${shape}, conflict: ${conflict}${reasonSuffix}; strategies: ${resolutionOptions.join(', ')}):\n--- base ---\n${base}\n--- ours ---\n${ours}\n--- theirs ---\n${theirs}`;
        return textPlusStructured(text, {
          content: {
            file,
            base,
            ours,
            theirs,
            shape,
            conflict,
            ...(reason === undefined ? {} : { reason }),
            conflictKind,
            resolutionOptions,
          },
        });
      }

      const result = await httpGet(url, '/api/sync/conflicts');
      if (!result.ok) {
        return textResult(`Error: ${result.error as string}`, true);
      }
      const rawConflicts = (result as { conflicts?: unknown }).conflicts;
      const conflicts = Array.isArray(rawConflicts) ? rawConflicts : [];
      const text =
        conflicts.length === 0
          ? 'No conflicts tracked.'
          : `Tracked conflicts (${conflicts.length}):\n${conflicts
              .map((row) => {
                const rec = (row ?? {}) as Record<string, unknown>;
                const file = typeof rec.file === 'string' ? rec.file : '';
                const conflict = typeof rec.conflict === 'string' ? rec.conflict : 'merge-native';
                const reason = typeof rec.reason === 'string' ? ` / ${rec.reason}` : '';
                return `- ${file} (${conflict}${reason})`;
              })
              .join('\n')}`;
      return textPlusStructured(text, { list: conflicts });
    },
  );
}
