import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMPTY_DETECTION_SNAPSHOT,
  type HostSnapshot,
  type PlannedStep,
  type ProbeSnapshot,
  type SatisfierId,
  type StepExecutor,
  type SurfaceState,
} from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, it } from 'vitest';
import { applyAgentRegistryIntents, NO_WRITER_EXECUTOR } from './agent-registry-apply.ts';
import { readBundleDecision } from './skill-state.ts';

const CLAUDE_PROJECT_MCP = 'claude/mcp/project/config-entry' as SatisfierId;
const _CLAUDE_PROJECT_SKILL = 'claude/skill/project/skill-bundle-copy' as SatisfierId;
const COPILOT_PROJECT_SKILL = 'copilot/skill/project/skill-bundle-copy' as SatisfierId;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-apply-'));
  tempDirs.push(dir);
  return dir;
}

function probesOf(states: Record<string, SurfaceState>): ProbeSnapshot {
  return {
    env: 'local-web',
    satisfiers: Object.fromEntries(Object.entries(states).map(([id, state]) => [id, { state }])),
  };
}

function snapshotOf(states: Record<string, SurfaceState> = {}): HostSnapshot {
  return { probes: probesOf(states), detection: EMPTY_DETECTION_SNAPSHOT };
}

function recordingExecutor(): { execute: StepExecutor; wrote: string[] } {
  const wrote: string[] = [];
  return {
    wrote,
    execute: (step: PlannedStep) => {
      wrote.push(step.satisfierId);
      return { action: step.desired === 'absent' ? 'removed' : 'written' };
    },
  };
}

describe('a batch with no writer injected', () => {
  it('reports every step unwritable instead of failing the request', async () => {
    const { report } = await applyAgentRegistryIntents(
      [{ satisfierId: CLAUDE_PROJECT_MCP, desired: 'present' }],
      { env: 'local-web', snapshot: async () => snapshotOf({ [CLAUDE_PROJECT_MCP]: 'absent' }) },
    );

    expect(report.actions).toHaveLength(1);
    expect(report.actions[0]?.action).toBe('skipped-unsupported');
    expect(report.actions[0]?.errorId).toBe('no-writer');
  });

  it('still returns a snapshot taken after the batch', async () => {
    const { snapshot } = await applyAgentRegistryIntents([], {
      env: 'local-web',
      snapshot: async () => snapshotOf({ [CLAUDE_PROJECT_MCP]: 'satisfied' }),
    });

    expect(snapshot.probes.satisfiers[CLAUDE_PROJECT_MCP]?.state).toBe('satisfied');
  });

  it('is the same answer the exported fallback gives on its own', () => {
    expect(NO_WRITER_EXECUTOR({} as PlannedStep)).toEqual({
      action: 'skipped-unsupported',
      errorId: 'no-writer',
    });
  });
});

describe('a batch with a writer injected', () => {
  it('runs the requested work and reports what happened to each artifact', async () => {
    const { execute, wrote } = recordingExecutor();

    const { report } = await applyAgentRegistryIntents(
      [{ satisfierId: CLAUDE_PROJECT_MCP, desired: 'present' }],
      {
        execute,
        env: 'local-web',
        snapshot: async () => snapshotOf({ [CLAUDE_PROJECT_MCP]: 'absent' }),
      },
    );

    expect(wrote).toEqual([CLAUDE_PROJECT_MCP]);
    expect(report.actions.map((action) => action.action)).toEqual(['written']);
  });

  it('does not touch an artifact that is already the way it was asked to be', async () => {
    const { execute, wrote } = recordingExecutor();

    const { report } = await applyAgentRegistryIntents(
      [{ satisfierId: CLAUDE_PROJECT_MCP, desired: 'present' }],
      {
        execute,
        env: 'local-web',
        snapshot: async () => snapshotOf({ [CLAUDE_PROJECT_MCP]: 'satisfied' }),
      },
    );

    expect(wrote).toEqual([]);
    expect(report.actions.map((action) => action.action)).toEqual(['unchanged']);
  });

  it('keeps going after a writer throws, and names the failure', async () => {
    const execute: StepExecutor = (step) => {
      if (step.satisfierId === CLAUDE_PROJECT_MCP) throw new Error('disk on fire');
      return { action: 'written' };
    };

    const { report } = await applyAgentRegistryIntents(
      [
        { satisfierId: CLAUDE_PROJECT_MCP, desired: 'present' },
        { satisfierId: COPILOT_PROJECT_SKILL, desired: 'present' },
      ],
      {
        execute,
        env: 'local-web',
        snapshot: async () =>
          snapshotOf({ [CLAUDE_PROJECT_MCP]: 'absent', [COPILOT_PROJECT_SKILL]: 'absent' }),
      },
    );

    const failed = report.actions.find((action) => action.satisfierId === CLAUDE_PROJECT_MCP);
    expect(failed?.action).toBe('failed');
    expect(failed?.errorId).toBe('executor-threw');
    const skill = report.actions.find((action) => action.satisfierId === COPILOT_PROJECT_SKILL);
    expect(skill?.action).toBe('written');
  });
});

describe('a batch built from an unusable request', () => {
  it('reports a submission that is not an intent as a conflict rather than throwing', async () => {
    const { report } = await applyAgentRegistryIntents(
      [{ satisfierId: undefined, desired: 'sideways' }],
      { env: 'local-web', snapshot: async () => snapshotOf() },
    );

    expect(report.actions).toEqual([]);
    expect(report.conflicts.map((conflict) => conflict.kind)).toContain('malformed-intent');
  });

  it('reports an artifact the registry does not carry', async () => {
    const { report } = await applyAgentRegistryIntents(
      [{ satisfierId: 'nope/mcp/user/config-entry', desired: 'present' }],
      { env: 'local-web', snapshot: async () => snapshotOf() },
    );

    expect(report.conflicts.map((conflict) => conflict.kind)).toContain('unknown-satisfier');
  });
});

describe('a snapshot that cannot be taken', () => {
  it('claims nothing rather than inventing an answer', async () => {
    const { report, snapshot } = await applyAgentRegistryIntents(
      [{ satisfierId: CLAUDE_PROJECT_MCP, desired: 'present' }],
      {
        execute: () => ({ action: 'written' }),
        env: 'local-web',
        snapshot: async () => {
          throw new Error('cannot read home');
        },
      },
    );

    expect(snapshot.detection.probed).toBe(false);
    expect(snapshot.probes.satisfiers).toEqual({});
    expect(report.actions.map((action) => action.action)).toEqual(['written']);
  });
});

describe('caller tier', () => {
  it('reports the caller tier it was given, not a hardcoded one, when the snapshot fails', async () => {
    const { snapshot } = await applyAgentRegistryIntents([], {
      env: 'remote-web',
      decisionHome: tempHome(),
      snapshot: async () => {
        throw new Error('unreadable');
      },
    });

    expect(snapshot.probes.env).toBe('remote-web');
    expect(snapshot.probes.satisfiers).toEqual({});
  });
});

describe('the user-global skill decision record', () => {
  const CLAUDE_USER_SKILL = 'claude/skill/user/skill-bundle-copy' as const;

  it('records true when a user-skill install lands', async () => {
    const home = tempHome();

    await applyAgentRegistryIntents([{ satisfierId: CLAUDE_USER_SKILL, desired: 'present' }], {
      execute: () => ({ action: 'written' }),
      env: 'local-web',
      decisionHome: home,
      snapshot: async () => snapshotOf(),
    });

    expect(await readBundleDecision(home, 'open-knowledge-discovery')).toBe(true);
  });

  it('records false when a removal empties the last copy', async () => {
    const home = tempHome();

    await applyAgentRegistryIntents([{ satisfierId: CLAUDE_USER_SKILL, desired: 'absent' }], {
      execute: () => ({ action: 'removed' }),
      env: 'local-web',
      decisionHome: home,
      userSkillPresentAnywhere: () => false,
      snapshot: async () => snapshotOf({ [CLAUDE_USER_SKILL]: 'satisfied' }),
    });

    expect(await readBundleDecision(home, 'open-knowledge-discovery')).toBe(false);
  });

  it('records nothing when the host never answered the disk question', async () => {
    const home = tempHome();

    await applyAgentRegistryIntents([{ satisfierId: CLAUDE_USER_SKILL, desired: 'absent' }], {
      execute: () => ({ action: 'removed' }),
      env: 'local-web',
      decisionHome: home,
      snapshot: async () => snapshotOf({ [CLAUDE_USER_SKILL]: 'satisfied' }),
    });

    expect(await readBundleDecision(home, 'open-knowledge-discovery')).toBe(null);
  });

  it('records nothing when a removal leaves a copy behind', async () => {
    const home = tempHome();

    await applyAgentRegistryIntents([{ satisfierId: CLAUDE_USER_SKILL, desired: 'absent' }], {
      execute: () => ({ action: 'removed' }),
      env: 'local-web',
      decisionHome: home,
      userSkillPresentAnywhere: () => true,
      snapshot: async () => snapshotOf({ [CLAUDE_USER_SKILL]: 'satisfied' }),
    });

    expect(await readBundleDecision(home, 'open-knowledge-discovery')).toBe(null);
  });
});
