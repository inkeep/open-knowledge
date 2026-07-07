/**
 * Single-source builder for the `mcp-config-migrate` structured event.
 *
 * Three surfaces emit this event — CLI `ok start` reclaim, Desktop boot
 * sweep, Desktop project-open sweep. They predate this builder and used
 * to ship three different field shapes for the same event name (`editor`
 * vs `editorId`, `configPath` present/absent, `priorArgs` truncated/not).
 * That defeated the point of a unified event name: operators who counted
 * `mcp-config-migrate` aggregated three incompatible schemas. This module
 * is the only sanctioned construction site.
 *
 * Standardized fields:
 *   - `scope`           — `'user' | 'project'` (cross-surface)
 *   - `surface`         — free-form identifier of the emitting code path
 *                         (`'cli-repair'`, `'desktop-startup'`,
 *                         `'desktop-project-open'`). Always set.
 *   - `editorId`        — matches `EditorMcpResult.editorId` and
 *                         `RepairLogEvent.editorId`.
 *   - `configPath`      — absolute path of the config file being rewritten.
 *   - `priorCommand`    — truncated to 200 chars or `null` if absent.
 *   - `priorArgs`       — first 10 entries, each string truncated to 200
 *                         chars (CHAIN_V1's `args[2]` shell body is ~700
 *                         chars; without truncation the event payload
 *                         blows up Tempo/Prometheus label storage and
 *                         every aggregation downstream).
 */

export type McpConfigMigrateScope = 'user' | 'project';

export interface McpConfigMigrateInput {
  scope: McpConfigMigrateScope;
  surface: string;
  editorId: string;
  configPath: string;
  priorEntry: Record<string, unknown>;
}

export interface McpConfigMigrateEvent {
  event: 'mcp-config-migrate';
  scope: McpConfigMigrateScope;
  surface: string;
  editorId: string;
  configPath: string;
  priorCommand: string | null;
  priorArgs: unknown[] | null;
  /**
   * Index signature so this type is assignable to the loosely-typed
   * `event: { event: string; [k: string]: unknown }` parameter the Desktop
   * structured-event loggers accept. Future extensions (e.g. a `traceId`
   * field) don't need a type-system migration in every consumer.
   */
  [key: string]: unknown;
}

export function buildMcpConfigMigrateEvent(input: McpConfigMigrateInput): McpConfigMigrateEvent {
  const { priorCommand, priorArgs } = truncatePriorEntry(input.priorEntry);
  return {
    event: 'mcp-config-migrate',
    scope: input.scope,
    surface: input.surface,
    editorId: input.editorId,
    configPath: input.configPath,
    priorCommand,
    priorArgs,
  };
}

/**
 * Bound the payload of `priorCommand` / `priorArgs` before structured-event
 * sinks index them. `CHAIN_V1`'s `args[2]` is a ~700-char shell script;
 * unbounded inclusion in a high-volume metric label explodes downstream
 * storage.
 *
 * Re-exported via `packages/cli/src/index.ts` for workspace-only
 * consumption — the Desktop `project-mcp-reclaim` sibling event applies
 * identical bounds. External consumers of `@inkeep/open-knowledge` should
 * reach for `buildMcpConfigMigrateEvent` instead; this helper is the
 * inner mechanism, not a stable surface.
 *
 * @internal
 */
export function truncatePriorEntry(entry: Record<string, unknown>): {
  priorCommand: string | null;
  priorArgs: unknown[] | null;
} {
  return {
    priorCommand: typeof entry.command === 'string' ? entry.command.slice(0, 200) : null,
    priorArgs: Array.isArray(entry.args)
      ? entry.args.slice(0, 10).map((arg) => (typeof arg === 'string' ? arg.slice(0, 200) : arg))
      : null,
  };
}
