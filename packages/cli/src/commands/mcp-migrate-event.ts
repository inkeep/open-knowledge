
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
