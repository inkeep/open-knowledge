import { z } from 'zod';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  HOCUSPOCUS_NOT_RUNNING_ERROR,
  httpPost,
  outputSchemaWithText,
  ROUTED_CWD_DESCRIPTION,
  resolveProjectServerContext,
  textPlusStructured,
  textResult,
} from './shared.ts';

const DESCRIPTION = [
  '[Requires: Hocuspocus server] Resolve a tracked merge conflict by writing the chosen content to disk and committing.',
  '',
  'Strategy:',
  '- `mine` — runs `git checkout --ours -- <file>` then `git add` (your committed ours stage, stage 2). Fails on delete-modify (DU) conflicts where stage 2 is missing — use `delete` instead.',
  '- `theirs` — runs `git checkout --theirs -- <file>` then `git add` (their committed stage 3). Fails on modify-delete (UD) conflicts where stage 3 is missing — use `delete` instead.',
  '- `content` — writes the provided `content` argument (e.g. a per-hunk merged result, or the live Y.Text bytes the user sees in the DiffView). The provided string must be non-empty — use `delete` to remove the file entirely (an agent constructing a per-hunk merge that happens to land on `""` gets a 400 at the Zod boundary rather than a misleading 500).',
  '- `delete` — runs `git rm <file>` then commits the deletion. Honors deletion intent for delete-modify (DU: "keep deletion") and modify-delete (UD: "accept their deletion") shapes. Inspect the `shape` field on `conflicts({ kind: "content" })` to pick the right strategy for the conflict shape.',
  '',
  'Returns 200 on success; 500 indicates commit failure (re-call `conflicts({ kind: "list" })` to confirm post-state — the resolve API is best-effort, non-atomic, and the file may have been resolved by another session).',
  '',
  '**DESTRUCTIVE:** this modifies the working tree and creates a git commit.',
  '',
  '**Parameters:**',
  '- `file` — Relative-to-projectDir path WITH .md extension (e.g. `notes/sso.md`).',
  '- `strategy` — One of `mine` | `theirs` | `content` | `delete`.',
  '- `content` — Required (non-empty) when `strategy === "content"`; ignored otherwise.',
].join('\n');

interface ResolveConflictDeps {
  serverUrl: ServerUrlOrResolver;
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
}

const OutputSchema = outputSchemaWithText({
  ok: z.boolean(),
  file: z.string(),
});

export function register(server: ServerInstance, deps: ResolveConflictDeps): void {
  server.registerTool(
    'resolve_conflict',
    {
      description: DESCRIPTION,
      inputSchema: {
        file: z
          .string()
          .min(1)
          .describe('Relative-to-projectDir path WITH .md extension (e.g. `notes/sso.md`).'),
        strategy: z
          .enum(['mine', 'theirs', 'content', 'delete'])
          .describe(
            'Resolution strategy. `content` requires the `content` arg. `delete` runs `git rm` — use for delete-vs-modify (DU/UD) shapes where one stage is missing.',
          ),
        content: z
          .string()
          .optional()
          .describe(
            'Exact bytes to write. Required when `strategy === "content"`; ignored otherwise.',
          ),
        cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
      },
      outputSchema: OutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
      },
    },
    async (args: {
      file: string;
      strategy: 'mine' | 'theirs' | 'content' | 'delete';
      content?: string;
      cwd?: string;
    }) => {
      const context = await resolveProjectServerContext(
        deps.resolveCwd,
        deps.config,
        deps.serverUrl,
        args.cwd,
      );
      if (!context.ok) return textResult(`Error: ${context.error}`, true);
      const { url } = context;
      if (!url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);

      const body: Record<string, unknown> = {
        file: args.file,
        strategy: args.strategy,
      };
      if (args.content !== undefined) body.content = args.content;

      const result = await httpPost(url, '/api/sync/resolve-conflict', body);
      if (!result.ok) {
        const error = result.error as string;
        const detail = typeof result.detail === 'string' ? result.detail : undefined;
        const message = detail ? `${error} — ${detail}` : error;
        return textPlusStructured(`Error: ${message}`, { ok: false, file: args.file }, true);
      }
      const text = `Resolved conflict on ${args.file} (strategy: ${args.strategy}).`;
      return textPlusStructured(text, { ok: true, file: args.file });
    },
  );
}
