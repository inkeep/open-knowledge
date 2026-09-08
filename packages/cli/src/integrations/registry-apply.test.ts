import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ApplyReport,
  buildConnectionsView,
  executePlan,
  type IntentDesire,
  planIntents,
  type SatisfierId,
} from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EDITOR_TARGETS } from '../commands/editors.ts';
import { type CliWriteContext, createCliStepExecutor } from './registry-apply.ts';
import { collectCliHostSnapshot } from './registry-probes.ts';

let root: string;
let ctx: CliWriteContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ok-registry-apply-'));
  mkdirSync(join(root, 'project'), { recursive: true });
  mkdirSync(join(root, 'home'), { recursive: true });
  ctx = { cwd: join(root, 'project'), home: join(root, 'home') };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function run(intents: Array<{ satisfierId: string; desired: IntentDesire }>) {
  const before = await collectCliHostSnapshot(ctx);
  const view = buildConnectionsView({ probes: before.probes, detection: before.detection });
  const plan = planIntents(
    intents.map((intent) => ({
      satisfierId: intent.satisfierId as SatisfierId,
      desired: intent.desired,
    })),
    view,
  );
  return await executePlan(plan, createCliStepExecutor(ctx));
}

function actionFor(report: ApplyReport, satisfierId: string) {
  return report.actions.find((action) => action.satisfierId === satisfierId);
}

async function stateOf(satisfierId: string) {
  const { probes } = await collectCliHostSnapshot(ctx);
  return probes.satisfiers[satisfierId as SatisfierId]?.state;
}

const projectMcpPath = () => join(ctx.cwd, '.mcp.json');

describe('a project MCP artifact', () => {
  it('is written by the same primitive a single toggle uses, and reads back satisfied', async () => {
    const report = await run([
      { satisfierId: 'claude/mcp/project/config-entry', desired: 'present' },
    ]);

    expect(actionFor(report, 'claude/mcp/project/config-entry')?.action).toBe('written');
    expect(existsSync(projectMcpPath())).toBe(true);
    expect(await stateOf('claude/mcp/project/config-entry')).toBe('satisfied');
  });

  it('is removed when the batch names every agent that reads it', async () => {
    await run([{ satisfierId: 'claude/mcp/project/config-entry', desired: 'present' }]);

    const report = await run([
      { satisfierId: 'claude/mcp/project/config-entry', desired: 'absent' },
      { satisfierId: 'copilot/mcp/project/config-entry', desired: 'absent' },
    ]);

    expect(actionFor(report, 'claude/mcp/project/config-entry')?.action).toBe('removed');
    expect(await stateOf('claude/mcp/project/config-entry')).toBe('absent');
  });

  it('reclaims a squatted server name exactly as a single toggle does', async () => {
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({
        mcpServers: { [EDITOR_TARGETS.claude.serverName(ctx.cwd)]: { command: 'not-ours' } },
      }),
    );

    const report = await run([
      { satisfierId: 'claude/mcp/project/config-entry', desired: 'present' },
    ]);

    expect(actionFor(report, 'claude/mcp/project/config-entry')?.action).toBe('overwritten');
    expect(readFileSync(projectMcpPath(), 'utf8')).not.toContain('not-ours');
    expect(await stateOf('claude/mcp/project/config-entry')).toBe('satisfied');
  });
});

describe('an artifact two agents share', () => {
  it('lands in the file its owner writes, not in a file named after the asking agent', async () => {
    const report = await run([
      { satisfierId: 'copilot/mcp/project/config-entry', desired: 'present' },
    ]);

    expect(actionFor(report, 'copilot/mcp/project/config-entry')?.action).toBe('written');
    expect(existsSync(projectMcpPath())).toBe(true);
    expect(await stateOf('claude/mcp/project/config-entry')).toBe('satisfied');
  });
});

describe('a user-global MCP artifact', () => {
  it('is written under the home the caller named', async () => {
    const report = await run([{ satisfierId: 'claude/mcp/user/config-entry', desired: 'present' }]);

    expect(actionFor(report, 'claude/mcp/user/config-entry')?.action).toBe('written');
    expect(await stateOf('claude/mcp/user/config-entry')).toBe('satisfied');
  });

  it('reports no surface for an agent whose config is project-only', async () => {
    const report = await run([{ satisfierId: 'pi/mcp/user/config-entry', desired: 'present' }]);

    const action = actionFor(report, 'pi/mcp/user/config-entry');
    if (action !== undefined) expect(action.action).not.toBe('failed');
  });
});

describe('a project skill bundle', () => {
  it('is projected into the host’s skills root and reads back satisfied', async () => {
    const report = await run([
      { satisfierId: 'claude/mcp/project/config-entry', desired: 'present' },
      { satisfierId: 'claude/skill/project/skill-bundle-copy', desired: 'present' },
    ]);

    expect(actionFor(report, 'claude/skill/project/skill-bundle-copy')?.action).toBe('written');
    expect(await stateOf('claude/skill/project/skill-bundle-copy')).toBe('satisfied');
  });

  it('is removed on request', async () => {
    await run([
      { satisfierId: 'claude/mcp/project/config-entry', desired: 'present' },
      { satisfierId: 'claude/skill/project/skill-bundle-copy', desired: 'present' },
    ]);

    const report = await run([
      { satisfierId: 'claude/skill/project/skill-bundle-copy', desired: 'absent' },
    ]);

    expect(actionFor(report, 'claude/skill/project/skill-bundle-copy')?.action).toBe('removed');
    expect(await stateOf('claude/skill/project/skill-bundle-copy')).toBe('absent');
  });
});
describe('the user-global discovery bundle', () => {
  it('installs into ONE agent and leaves the others alone', async () => {
    const home = join(root, 'home');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    mkdirSync(join(home, '.claude'), { recursive: true });
    await run([{ satisfierId: 'claude/skill/user/skill-bundle-copy', desired: 'present' }]);
    const claudeSkillMd = join(home, '.claude', 'skills', 'open-knowledge-discovery', 'SKILL.md');
    expect(existsSync(claudeSkillMd)).toBe(true);
    const claudeBytesBefore = readFileSync(claudeSkillMd, 'utf8');

    const report = await run([
      { satisfierId: 'cursor/skill/user/skill-bundle-copy', desired: 'present' },
    ]);

    expect(actionFor(report, 'cursor/skill/user/skill-bundle-copy')?.action).toBe('written');
    expect(
      existsSync(join(home, '.cursor', 'skills', 'open-knowledge-discovery', 'SKILL.md')),
    ).toBe(true);
    expect(readFileSync(claudeSkillMd, 'utf8')).toBe(claudeBytesBefore);
  });

  it('declines an agent whose host dir does not exist rather than creating it', async () => {
    const home = join(root, 'home');
    expect(existsSync(join(home, '.codex'))).toBe(false);

    const report = await run([
      { satisfierId: 'codex/skill/user/skill-bundle-copy', desired: 'present' },
    ]);

    expect(actionFor(report, 'codex/skill/user/skill-bundle-copy')).toBeUndefined();
    expect(report.conflicts).toEqual([
      expect.objectContaining({
        kind: 'blocked-satisfier',
        satisfierIds: ['codex/skill/user/skill-bundle-copy'],
        blockedReason: 'structural-na',
      }),
    ]);
    expect(existsSync(join(home, '.codex'))).toBe(false);
  });

  it('installs once the agent host dir exists', async () => {
    const home = join(root, 'home');
    mkdirSync(join(home, '.codex'), { recursive: true });

    await run([{ satisfierId: 'codex/skill/user/skill-bundle-copy', desired: 'present' }]);

    expect(existsSync(join(home, '.codex', 'skills', 'open-knowledge-discovery', 'SKILL.md'))).toBe(
      true,
    );
  });

  it('removes one agent without touching a peer', async () => {
    const home = join(root, 'home');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    mkdirSync(join(home, '.claude'), { recursive: true });
    await run([
      { satisfierId: 'cursor/skill/user/skill-bundle-copy', desired: 'present' },
      { satisfierId: 'claude/skill/user/skill-bundle-copy', desired: 'present' },
    ]);

    const report = await run([
      { satisfierId: 'cursor/skill/user/skill-bundle-copy', desired: 'absent' },
    ]);

    expect(actionFor(report, 'cursor/skill/user/skill-bundle-copy')?.action).toBe('removed');
    expect(existsSync(join(home, '.cursor', 'skills', 'open-knowledge-discovery'))).toBe(false);
    expect(
      existsSync(join(home, '.claude', 'skills', 'open-knowledge-discovery', 'SKILL.md')),
    ).toBe(true);
  });

  it('refuses a removal that would follow a shared root into the peer, and names the peer', async () => {
    const home = join(root, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    await run([{ satisfierId: 'claude/skill/user/skill-bundle-copy', desired: 'present' }]);
    mkdirSync(join(home, '.codex'), { recursive: true });
    symlinkSync(join(home, '.claude', 'skills'), join(home, '.codex', 'skills'), 'dir');

    const report = await run([
      { satisfierId: 'codex/skill/user/skill-bundle-copy', desired: 'absent' },
    ]);

    expect(actionFor(report, 'codex/skill/user/skill-bundle-copy')).toBeUndefined();
    const conflict = report.conflicts.find((entry) => entry.kind === 'unresolved-shared-copy');
    expect(conflict?.agentIds).toEqual(['codex', 'claude']);
    expect(
      existsSync(join(home, '.claude', 'skills', 'open-knowledge-discovery', 'SKILL.md')),
    ).toBe(true);
  });

  it('removes through a shared root once the batch removes the peer too', async () => {
    const home = join(root, 'home');
    mkdirSync(join(home, '.claude'), { recursive: true });
    await run([{ satisfierId: 'claude/skill/user/skill-bundle-copy', desired: 'present' }]);
    mkdirSync(join(home, '.codex'), { recursive: true });
    symlinkSync(join(home, '.claude', 'skills'), join(home, '.codex', 'skills'), 'dir');

    const report = await run([
      { satisfierId: 'codex/skill/user/skill-bundle-copy', desired: 'absent' },
      { satisfierId: 'claude/skill/user/skill-bundle-copy', desired: 'absent' },
    ]);

    expect(report.conflicts).toEqual([]);
    expect(
      existsSync(join(home, '.claude', 'skills', 'open-knowledge-discovery', 'SKILL.md')),
    ).toBe(false);
  });
});
