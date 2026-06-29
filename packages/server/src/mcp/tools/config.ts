
import { z } from 'zod';
import type { ConfigOrResolver, ServerInstance } from './shared.ts';
import {
  outputSchemaWithText,
  ROUTED_CWD_DESCRIPTION,
  resolveProjectConfigContext,
  textPlusStructured,
} from './shared.ts';

const DESCRIPTION = [
  '[Operates on disk; no running OK server required] Read the effective merged OpenKnowledge config (defaults → user → project).',
  '',
  'Use this when you need to inspect the config mid-session — e.g., after a write that may have changed disk state, or to re-confirm the value of a field before reading it again.',
  '',
  'Read returns the FULL merged config or a sub-tree when `key` is provided. There is no allowlist on reads — every field is readable.',
  '',
  'Note: the `server.*`, `mcp.*`, and `github.*` config sub-trees, plus `preview.baseUrl` and `preview.scriptSrc`, were removed; their values are now built-in constants in `@inkeep/open-knowledge-core` (or, for the preview iframe, a fixed open network policy). Reading those keys returns `exists: false`. (`appearance.preview.autoOpen` is still a live key.)',
  '',
  '**Parameters:**',
  '- `key` (optional) — Dotted config key. `"content"` returns the content sub-tree; `"appearance.theme"` returns just that leaf. Omit for full config.',
  '- `cwd` (optional) — Project root (see `cwd` description below).',
].join('\n');

interface GetConfigDeps {
  resolveCwd: (explicit?: string) => Promise<string>;
  config: ConfigOrResolver;
}

const InputSchema = {
  key: z
    .string()
    .optional()
    .describe(
      'Dotted config key (e.g. "appearance.theme"). Omit to return the full merged config.',
    ),
  cwd: z.string().optional().describe(ROUTED_CWD_DESCRIPTION),
} as const;

const OutputSchema = outputSchemaWithText({
  value: z.unknown().describe('Resolved config value at the requested path (or full config).'),
  exists: z
    .boolean()
    .optional()
    .describe(
      'Whether the requested path resolved to a value. `false` distinguishes ' +
        '"path absent" from "path explicitly set to null". Always emitted — `true` on a full-config read.',
    ),
  key: z
    .string()
    .optional()
    .describe('Echo of the requested dotted key (absent when reading the full config).'),
});

function readConfigPath(value: unknown, path: readonly string[]): unknown {
  let cur: unknown = value;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function register(server: ServerInstance, deps: GetConfigDeps): void {
  server.registerTool(
    'config',
    {
      description: DESCRIPTION,
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async (args: { key?: string; cwd?: string }) => {
      const context = await resolveProjectConfigContext(deps.resolveCwd, deps.config, args.cwd);
      if (!context.ok) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Error: ${context.error}` }],
        };
      }
      const segments = args.key ? args.key.split('.').filter((s) => s.length > 0) : [];
      const value = segments.length > 0 ? readConfigPath(context.config, segments) : context.config;
      if (segments.length > 0 && value === undefined) {
        return textPlusStructured(`(no value at ${args.key})`, {
          value: null,
          exists: false,
          ...(args.key ? { key: args.key } : {}),
        });
      }
      return textPlusStructured(JSON.stringify(value, null, 2), {
        value,
        exists: true,
        ...(args.key ? { key: args.key } : {}),
      });
    },
  );
}
