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
  '[Requires: Hocuspocus server] Resolve a tracked conflict by writing the chosen content to disk. Only the strategies listed in `resolutionOptions` on `conflicts({ kind: "content" })` apply.',
  '',
  'Strategy:',
  '- `mine` — runs `git checkout --ours -- <file>` then `git add` (your committed ours stage, stage 2). Fails on delete-modify (DU) conflicts where stage 2 is missing — use `delete` instead.',
  '- `theirs` — runs `git checkout --theirs -- <file>` then `git add` (their committed stage 3). Fails on modify-delete (UD) conflicts where stage 3 is missing — use `delete` instead.',
  '- `content` — writes the exact provided `content` bytes (e.g. a per-hunk merged result, the live Y.Text shown in the DiffView, or an explicit empty string). Use `delete` to remove the file.',
  '- `delete` — runs `git rm <file>`, which stages the removal rather than committing it on its own. Honors deletion intent for delete-modify (DU: "keep deletion") and modify-delete (UD: "accept their deletion") shapes. Inspect the `shape` field on `conflicts({ kind: "content" })` to pick the right strategy for the conflict shape.',
  '',
  'Those git mechanics are the `merge-native` kind (a git merge left unmerged stages); its merge is committed once it was the last tracked `merge-native` conflict, and other kinds do not hold that commit back. On a `working-tree` conflict (a pull-only overlay collision pinned to an origin blob) nothing is committed: `mine` keeps the overlay verbatim, `theirs` restores the pinned origin blob. On a `reconcile` conflict (OK\'s own merge of editor and disk) the chosen bytes land on disk and in the loaded document with no git command, and `mine` uses the latest marker-free live Y.Text, falling back to the captured editor stage when the document is unloaded or contains markers; `theirs` uses the disk stage captured at detection — for `reason: "stale-external-write"`, the current local content and the rejected older save. `resolutionOptions` drops `theirs` when a `reconcile` conflict\'s `theirs` side is raw marker text (`reason` of `disk-markers` or `refused-conflict-markers`), and drops `content` for `refused-too-large`.',
  '',
  'Returns 200 on success. 404 (`urn:ok:error:no-conflict-tracked`) means no conflict is tracked for that path — it may have been resolved by another session, or the path may be stale; re-read `conflicts({ kind: "list" })` rather than inferring that your resolution was saved. 422 (`urn:ok:error:unresolved-conflict-markers`) carries a `refusal` field telling two cases apart: `markers-in-content` means the `content` you sent still contains a `<<<<<<< … >>>>>>>` block — a permanent rejection of those bytes, so resolve every region before retrying rather than re-sending; `strategy-not-offered` means your strategy is not among the `resolutionOptions` the same body echoes — pick one from that list. 500 indicates commit failure (re-call `conflicts({ kind: "list" })` to confirm post-state — the resolve API is best-effort, non-atomic, and the file may have been resolved by another session).',
  '',
  '**DESTRUCTIVE:** this modifies the working tree, and a `merge-native` resolve also creates a git commit once it was the last tracked `merge-native` conflict.',
  '',
  '**Parameters:**',
  '- `file` — Relative-to-projectDir path WITH .md or .mdx extension (e.g. `notes/sso.md`).',
  "- `strategy` — One of `mine` | `theirs` | `content` | `delete`, narrowed by the conflict's `resolutionOptions`.",
  '- `content` — Required when `strategy === "content"`; an empty string keeps an empty file. Ignored otherwise.',
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
          .describe(
            'Relative-to-projectDir path WITH .md or .mdx extension (e.g. `notes/sso.md`).',
          ),
        strategy: z
          .enum(['mine', 'theirs', 'content', 'delete'])
          .describe(
            "Resolution strategy, narrowed by the conflict's `resolutionOptions`. `content` requires the `content` arg. On a `merge-native` conflict, `delete` runs `git rm`; on the other kinds it removes the file with no git command. Use `delete` for delete-vs-modify (DU/UD) shapes where one stage is missing.",
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
