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
  '[Requires: Hocuspocus server] Resolve a tracked Git merge or local stale external-write conflict. Inspect `conflictKind` and any `variant` from conflicts({ kind: "list" }), then fetch conflicts({ kind: "content", file }) to choose exact versions.',
  '',
  'Strategy:',
  '- `mine` — for a stale external write, keeps the protected live or recovered version. For a Git index conflict, selects committed stage 2; for a working-tree conflict, keeps the current working-tree file. A missing Git stage requires `delete` instead.',
  '- `theirs` — for a stale external write, accepts the rejected disk version. For a Git conflict, selects the incoming version (stage 3 for index conflicts). A missing Git stage requires `delete` instead.',
  '- `content` — writes the exact provided string, including `""` to keep an empty file. Use this to preserve the live Y.Text bytes returned as `ours`, which can differ from the Git version selected by `mine`. Omitted content is rejected.',
  '- `delete` — removes the file explicitly. For Git index conflicts, stages the deletion. For stale external writes and Git working-tree overlays, clears the conflict without a resolution commit.',
  '',
  'Returns 200 on success. 422 (`urn:ok:error:unresolved-conflict-markers`) means the provided content still contains an unresolved conflict block. A 500 can indicate disk, bridge, recovery-snapshot, or Git commit failure. Re-call conflicts({ kind: "list" }) and inspect content before retrying: resolution is best-effort and non-atomic. Local stale-write protection remains until resolution succeeds.',
  '',
  '**DESTRUCTIVE:** this modifies the working tree. Git index resolutions stage each file and commit when the last conflict clears. Local stale external-write and Git working-tree overlay resolutions do not create a resolution commit.',
  '',
  '**Parameters:**',
  '- `file` — Exact relative-to-projectDir path WITH .md or .mdx extension (e.g. `notes/sso.md`).',
  '- `strategy` — One of `mine` | `theirs` | `content` | `delete`.',
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
            'Exact relative-to-projectDir path WITH .md or .mdx extension (e.g. `notes/sso.md`).',
          ),
        strategy: z
          .enum(['mine', 'theirs', 'content', 'delete'])
          .describe(
            'Resolution strategy. `content` requires exact bytes, including an empty string. `delete` explicitly removes the file. Inspect list conflictKind and variant, then content: Git index, working-tree, and stale external-write sides differ.',
          ),
        content: z
          .string()
          .optional()
          .describe(
            'Exact bytes to write, including an empty string to keep an empty file. Required when strategy is content; ignored otherwise.',
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
