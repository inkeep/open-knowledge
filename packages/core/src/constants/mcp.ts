export const READ_DOCUMENT_HISTORY_DEPTH = 5;

export const GREP_MAX_RESULTS = 50;

export const MCP_SERVER_NAME = 'open-knowledge';

export const OPEN_KNOWLEDGE_MCP_TOOLS = [
  'exec',
  'search',
  'history',
  'links',
  'skills',
  'config',
  'palette',
  'preview_url',
  'share_link',
  'lint',
  'audit',
  'write',
  'edit',
  'delete',
  'move',
  'install',
  'import',
  'checkpoint',
  'restore_version',
  'conflicts',
  'resolve_conflict',
] as const;

export type OpenKnowledgeMcpTool = (typeof OPEN_KNOWLEDGE_MCP_TOOLS)[number];

export const OPEN_KNOWLEDGE_MCP_WRITE_TOOLS = [
  'write',
  'edit',
  'delete',
  'move',
  'install',
  'import',
  'checkpoint',
  'restore_version',
  'resolve_conflict',
] as const satisfies ReadonlyArray<OpenKnowledgeMcpTool>;

export const OK_HOSTED_AGENT_ENV = 'OK_HOSTED_AGENT';

export const OK_DESKTOP_TERMINAL_ENV = 'OK_DESKTOP_TERMINAL';

export function resolveIsHostedAgent(env: Record<string, string | undefined>): boolean {
  return env[OK_DESKTOP_TERMINAL_ENV] === '1' || env[OK_HOSTED_AGENT_ENV] === '1';
}
