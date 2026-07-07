/**
 * `checkpoint` MCP tool — project-wide version snapshot of every document.
 *
 * Wraps `POST /api/save-version`. An optional `summary` labels the checkpoint
 * (it threads into the checkpoint commit subject; defaults to "Checkpoint
 * version"). Find checkpoints later via `history`.
 *
 * `restore_version` is the per-doc restore counterpart.
 */
import { z } from 'zod';
import type { AgentIdentity } from '../agent-identity.ts';
import type { ConfigOrResolver, ServerInstance, ServerUrlOrResolver } from './shared.ts';
import {
  HOCUSPOCUS_NOT_RUNNING_ERROR,
  httpPost,
  outputSchemaWithText,
  previewUrlOutputField,
  ROUTED_CWD_DESCRIPTION,
  resolveProjectServerContext,
  summaryArgSchema,
  textPlusStructured,
  textResult,
  VERSION_FIELD_DESCRIBE,
} from './shared.ts';

export const DESCRIPTION = [
  '[Requires: Hocuspocus server] Save a project-wide checkpoint of every document — a single restore point you can return to.',
  '',
  '**Parameters:**',
  '- `summary` — Optional one-line label for the checkpoint (≤80 chars). Defaults to "Checkpoint version". Appears as the checkpoint subject in `history`. Avoid secrets or PII — persisted to git history.',
  '',
  'Returns `{ version }` — the 40-char checkpoint SHA. Find checkpoints later via `history`; restore a single doc with `restore_version({ document, version })`.',
].join('\n');

export interface CheckpointDeps {
  serverUrl: ServerUrlOrResolver;
  config: ConfigOrResolver;
  resolveCwd: (explicit?: string) => Promise<string>;
  identityRef?: { current: AgentIdentity };
}

export function register(server: ServerInstance, deps: CheckpointDeps): void {
  server.registerTool(
    'checkpoint',
    {
      description: DESCRIPTION,
      inputSchema: {
        summary: summaryArgSchema.describe(
          'Optional one-line label for the checkpoint (≤80 chars). Defaults to "Checkpoint version". Persisted to git history.',
        ),
        cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
      },
      outputSchema: outputSchemaWithText({
        version: z.string().describe(VERSION_FIELD_DESCRIBE),
        previewUrl: previewUrlOutputField.describe(
          'Always null — a checkpoint is project-wide, not scoped to one doc.',
        ),
      }),
    },
    async (args: { summary?: string; cwd?: string }) => {
      const context = await resolveProjectServerContext(
        deps.resolveCwd,
        deps.config,
        deps.serverUrl,
        args.cwd,
      );
      if (!context.ok) return textResult(`Error: ${context.error}`, true);
      const { url } = context;
      if (!url) return textResult(HOCUSPOCUS_NOT_RUNNING_ERROR, true);

      const identity = deps.identityRef?.current;
      const result = await httpPost(url, '/api/save-version', {
        ...(args.summary !== undefined ? { summary: args.summary } : {}),
        ...(identity
          ? {
              writers: [
                {
                  id: `agent-${identity.connectionId}`,
                  name: identity.displayName,
                  email: `agent-${identity.connectionId}@openknowledge.local`,
                },
              ],
            }
          : {}),
      });
      if (!result.ok) return textResult(`Error: ${result.error}`, true);

      // The route returns the full ref `refs/checkpoints/<branch>/<sha>`; the
      // agent-facing `version` must be the bare 40-char SHA (its final segment)
      // so it round-trips through `restore_version`'s 40-hex input validation.
      const checkpointRef = typeof result.checkpointRef === 'string' ? result.checkpointRef : '';
      const version = checkpointRef.split('/').pop() ?? '';
      // Guard the round-trip contract: an empty/malformed ref would emit
      // `version: ''`, which `restore_version` rejects with no hint the
      // checkpoint itself succeeded. `''.split('/').pop()` is `''` (not
      // undefined), so the `?? ''` above can't catch it — validate the shape.
      if (!/^[0-9a-f]{40}$/i.test(version)) {
        return textResult(
          `Error: checkpoint committed but the server returned no usable version ref ("${checkpointRef}"). Find the latest checkpoint via \`history\`.`,
          true,
        );
      }
      return textPlusStructured(`Checkpoint saved. Version: ${version}`, {
        version,
        previewUrl: null,
      });
    },
  );
}
