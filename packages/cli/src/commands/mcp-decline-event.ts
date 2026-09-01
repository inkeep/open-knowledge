import type { McpDeclineReason } from './init.ts';

export type McpConfigDeclineScope = 'user' | 'project';

type McpConfigDeclineSurface = 'desktop-startup' | 'desktop-project-open' | 'desktop-firstlaunch';

interface McpConfigDeclineInput {
  scope: McpConfigDeclineScope;
  surface: McpConfigDeclineSurface;
  editorId: string;
  reason: McpDeclineReason;
}

export interface McpConfigDeclineEvent {
  event: 'mcp-config-decline';
  scope: McpConfigDeclineScope;
  surface: McpConfigDeclineSurface;
  editorId: string;
  reason: McpDeclineReason;
  [key: string]: unknown;
}

export function buildMcpConfigDeclineEvent(input: McpConfigDeclineInput): McpConfigDeclineEvent {
  return {
    event: 'mcp-config-decline',
    scope: input.scope,
    surface: input.surface,
    editorId: input.editorId,
    reason: input.reason,
  };
}
