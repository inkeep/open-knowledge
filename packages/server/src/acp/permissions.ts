import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionOption, ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { PinoLogger } from '../logger.ts';

const PERMISSIONS_FILE = 'acp-permissions.json';

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

  decide(agentId: string, toolCall: ToolCallUpdate, options: PermissionOption[]): PolicyDecision {
    const kind = toolKindOf(toolCall);
    const allow = pickOption(options, ['allow_once', 'allow_always']);
    if (allow === undefined) return { auto: null };
    if (kind === 'read') return { auto: { optionId: allow.optionId } };
    if (this.hasAllowAlways(agentId, kind)) return { auto: { optionId: allow.optionId } };
    return { auto: null };
  }

  hasAllowAlways(agentId: string, toolKind: string): boolean {
    return this.loadGrants().some((g) => g.agentId === agentId && g.toolKind === toolKind);
  }

  async recordChoice(
    agentId: string,
    toolCall: ToolCallUpdate,
    chosen: PermissionOption,
  ): Promise<void> {
    if (chosen.kind !== 'allow_always') return;
    const kind = toolKindOf(toolCall);
    if (this.hasAllowAlways(agentId, kind)) return;
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
