import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionOption, ToolCallUpdate } from '@agentclientprotocol/sdk';
import { OK_GATED_TOOL_NAMES } from '@inkeep/open-knowledge-core';
import type { ThreadChatGrant } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { identifyOpenKnowledgeToolCall } from '@inkeep/open-knowledge-core/acp/tool-call-input';
import { readConfigSafely, resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import type { PinoLogger } from '../logger.ts';
import type { BrowserCallIdentity } from './browser-mcp.ts';
import { readOnlyShellCommand } from './read-only-shell.ts';

const PERMISSIONS_FILE = 'acp-permissions.json';

const NO_CHAT_GRANTS: ReadonlySet<ThreadChatGrant> = new Set();

const GATED_OK_TOOLS: ReadonlySet<string> = new Set(OK_GATED_TOOL_NAMES);

function gatedOkTool(toolCall: ToolCallUpdate): boolean {
  const tool = identifyOpenKnowledgeToolCall(toolCall, 'known')?.tool;
  return tool !== undefined && GATED_OK_TOOLS.has(tool);
}

const reportedConfigProblems = new Set<string>();

function readAgentsConfig(projectDir: string, homedirOverride?: string, log?: PinoLogger) {
  return readConfigSafely({
    absPath: resolveConfigPath('user', projectDir, homedirOverride),
    sideline: false,
    warn: (message) => {
      if (log === undefined || reportedConfigProblems.has(message)) return;
      reportedConfigProblems.add(message);
      log.warn({ message }, '[acp-permissions] user config could not be read');
    },
  }).value.agents;
}

export function readAutoApproveOkTools(
  projectDir: string,
  homedirOverride?: string,
  log?: PinoLogger,
): boolean {
  return readAgentsConfig(projectDir, homedirOverride, log)?.autoApproveOkTools !== false;
}

export function readAgentBrowserTools(
  projectDir: string,
  homedirOverride?: string,
  log?: PinoLogger,
): boolean {
  return readAgentsConfig(projectDir, homedirOverride, log)?.browserTools === true;
}

export function offeredPermissionOptions(
  browser: BrowserCallIdentity,
  options: PermissionOption[],
): PermissionOption[] {
  if (browser.kind === 'none') return options;
  return options.filter((o) => o.kind !== 'allow_always');
}

interface PermissionGrant {
  agentId: string;
  toolKind: string;
}

interface PermissionsFileShape {
  version: 1;
  grants: PermissionGrant[];
}

export interface PolicyDecision {
  auto: { optionId: string } | null;
}

function toolKindOf(toolCall: ToolCallUpdate): string {
  return toolCall.kind ?? 'other';
}

function allowAlwaysGrantKind(
  toolCall: ToolCallUpdate,
  browser: BrowserCallIdentity,
): string | null {
  if (browser.kind !== 'none' || gatedOkTool(toolCall)) return null;
  return toolKindOf(toolCall);
}

function pickOption(
  options: PermissionOption[],
  kinds: readonly string[],
): PermissionOption | undefined {
  for (const kind of kinds) {
    const hit = options.find((o) => o.kind === kind);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export class AcpPermissionStore {
  private readonly filePath: string;
  private readonly log: PinoLogger;
  private grants: PermissionGrant[] | null = null;

  constructor(localDir: string, log: PinoLogger) {
    this.filePath = join(localDir, PERMISSIONS_FILE);
    this.log = log;
  }

  decide(
    agentId: string,
    toolCall: ToolCallUpdate,
    options: PermissionOption[],
    browser: BrowserCallIdentity,
    grants: ReadonlySet<ThreadChatGrant> = NO_CHAT_GRANTS,
    autoApproveOkTools = true,
  ): PolicyDecision {
    const allow = pickOption(options, ['allow_once', 'allow_always']);
    if (allow === undefined) return { auto: null };
    const auto: PolicyDecision = { auto: { optionId: allow.optionId } };
    if (browser.kind !== 'none') return { auto: null };
    const okTool = identifyOpenKnowledgeToolCall(toolCall, 'known')?.tool;
    if (okTool !== undefined) {
      if (GATED_OK_TOOLS.has(okTool)) return { auto: null };
      if (autoApproveOkTools) return auto;
    }
    const kind = toolKindOf(toolCall);
    if (kind === 'read') return auto;
    if (grants.has('read_only_shell') && readOnlyShellCommand(toolCall) !== null) return auto;
    if (this.hasAllowAlways(agentId, kind)) return auto;
    return { auto: null };
  }

  hasAllowAlways(agentId: string, toolKind: string): boolean {
    return this.loadGrants().some((g) => g.agentId === agentId && g.toolKind === toolKind);
  }

  async recordChoice(
    agentId: string,
    toolCall: ToolCallUpdate,
    chosen: PermissionOption,
    browser: BrowserCallIdentity,
  ): Promise<void> {
    if (chosen.kind !== 'allow_always') return;
    const kind = allowAlwaysGrantKind(toolCall, browser);
    if (kind === null || this.hasAllowAlways(agentId, kind)) return;
    const grants = [...this.loadGrants(), { agentId, toolKind: kind }];
    this.grants = grants;
    try {
      const { tracedMkdir, tracedWriteFile } = await import('../fs-traced.ts');
      await tracedMkdir(join(this.filePath, '..'), { recursive: true });
      const body: PermissionsFileShape = { version: 1, grants };
      await tracedWriteFile(this.filePath, `${JSON.stringify(body, null, 2)}\n`);
    } catch (err) {
      this.log.warn({ err }, '[acp-permissions] persisting allow_always grant failed');
    }
  }

  private loadGrants(): PermissionGrant[] {
    if (this.grants !== null) return this.grants;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PermissionsFileShape;
      this.grants = Array.isArray(parsed?.grants)
        ? parsed.grants.filter(
            (g) => typeof g?.agentId === 'string' && typeof g?.toolKind === 'string',
          )
        : [];
    } catch {
      this.grants = [];
    }
    return this.grants;
  }
}
