import type { HostSnapshot, SurfaceState } from '@inkeep/open-knowledge-core';
import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, test } from 'vitest';
import type {
  AgentIntegrationsApplyRequest,
  AgentIntegrationsApplyResult,
  McpWiringEditorId,
} from '../shared/ipc-channels.ts';
import {
  type AgentRegistryWriterSurfaces,
  applyIntents,
  createAgentIntegrationsApplyDelegate,
} from './agent-registry-apply.ts';

const PROJECT = '/proj';
const EVENT = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent;

const CLAUDE_USER_MCP = 'claude/mcp/user/config-entry';
const CLAUDE_PROJECT_MCP = 'claude/mcp/project/config-entry';
const CLAUDE_PROJECT_SKILL = 'claude/skill/project/skill-bundle-copy';
const CLAUDE_USER_SKILL = 'claude/skill/user/skill-bundle-copy';
const CODEX_PROJECT_SKILL = 'codex/skill/project/skill-bundle-copy';
const CODEX_PROJECT_MCP = 'codex/mcp/project/config-entry';
const COPILOT_PROJECT_MCP = 'copilot/mcp/project/config-entry';

interface Calls {
  userWrites: McpWiringEditorId[];
  userRemovals: McpWiringEditorId[];
  projectWrites: Array<{ id: McpWiringEditorId; path: string }>;
  projectRemovals: Array<{ id: McpWiringEditorId; path: string }>;
  skillWrites: McpWiringEditorId[];
  skillRemovals: McpWiringEditorId[];
  userSkillWrites: McpWiringEditorId[];
  userSkillRemovals: McpWiringEditorId[];
  userSkillDecisions: boolean[];
}

interface SurfaceOverrides {
  userWriteAction?: 'written' | 'overwritten' | 'declined' | 'failed' | 'skipped-missing';
  userRemoveKind?: 'removed' | 'not-present' | 'left-foreign' | 'declined';
  projectWriteAction?: 'written' | 'overwritten' | 'declined' | 'failed';
  projectRemoveKind?: 'removed' | 'not-present' | 'left-foreign' | 'declined';
  projectWriteThrows?: boolean;
  skillWriteAction?: 'written' | 'overwritten' | 'skipped-unsupported' | 'failed';
  userSkillWriteAction?: 'written' | 'overwritten' | 'skipped-unsupported' | 'failed';
  userSkillPresentAnywhere?: boolean;
  userSkillRemoveAction?: 'removed' | 'not-present' | 'skipped-unsupported' | 'failed';
  projectConfigFor?: McpWiringEditorId[];
}

function makeSurfaces(
  overrides: SurfaceOverrides = {},
): AgentRegistryWriterSurfaces & { calls: Calls } {
  const calls: Calls = {
    userWrites: [],
    userRemovals: [],
    projectWrites: [],
    projectRemovals: [],
    skillWrites: [],
    skillRemovals: [],
    userSkillWrites: [],
    userSkillRemovals: [],
    userSkillDecisions: [],
  };
  const withProjectConfig = new Set<string>(
    overrides.projectConfigFor ?? ['claude', 'codex', 'cursor', 'opencode', 'pi'],
  );

  return {
    calls,
    global: {
      allEditorIds: ['claude', 'codex', 'cursor', 'copilot', 'opencode', 'claude-desktop'],
      writeUserMcpConfigs: async ({ editors }) => {
        calls.userWrites.push(...editors);
        return editors.map((editorId) => ({
          editorId,
          action: overrides.userWriteAction ?? ('written' as const),
        }));
      },
      removeUserMcpEntry: (editorId) => {
        calls.userRemovals.push(editorId);
        return { kind: overrides.userRemoveKind ?? ('removed' as const) };
      },
      writeUserSkill: (editorId) => {
        calls.userSkillWrites.push(editorId);
        return { action: overrides.userSkillWriteAction ?? ('written' as const) };
      },
      userSkillPresentAnywhere: () => overrides.userSkillPresentAnywhere ?? false,
      recordUserSkillDecision: (enabled) => {
        calls.userSkillDecisions.push(enabled);
      },
      removeUserSkill: (editorId) => {
        calls.userSkillRemovals.push(editorId);
        return { action: overrides.userSkillRemoveAction ?? ('removed' as const) };
      },
    },
    project: {
      projectConfigPath: (id, projectDir) =>
        withProjectConfig.has(id) ? `${projectDir}/${id}.config` : null,
      writeProjectMcpConfig: ({ id, projectPath }) => {
        if (overrides.projectWriteThrows) throw new Error('exploded');
        calls.projectWrites.push({ id, path: projectPath });
        const action = overrides.projectWriteAction ?? 'written';
        if (action === 'failed') return { action: 'failed', error: 'disk full' };
        if (action === 'declined') return { action: 'declined', reason: 'unparseable' };
        return { action };
      },
      removeProjectMcpEntry: (id, _projectDir, projectPath) => {
        calls.projectRemovals.push({ id, path: projectPath });
        return { kind: overrides.projectRemoveKind ?? 'removed' } as ReturnType<
          AgentRegistryWriterSurfaces['project']['removeProjectMcpEntry']
        >;
      },
      writeProjectSkill: (id) => {
        calls.skillWrites.push(id);
        const action = overrides.skillWriteAction ?? 'written';
        return action === 'failed' ? { action: 'failed', error: 'nope' } : { action };
      },
      removeProjectSkill: (id) => {
        calls.skillRemovals.push(id);
        return { action: 'removed' };
      },
    },
  };
}

function snapshotWith(states: Record<string, SurfaceState>): HostSnapshot {
  return {
    probes: {
      env: 'desktop',
      satisfiers: Object.fromEntries(Object.entries(states).map(([id, state]) => [id, { state }])),
    },
    detection: { detected: ['claude', 'codex', 'copilot'], probed: true },
  };
}

function want(satisfierId: string): AgentIntegrationsApplyRequest['intents'][number] {
  return { satisfierId, desired: 'present' };
}

function drop(satisfierId: string): AgentIntegrationsApplyRequest['intents'][number] {
  return { satisfierId, desired: 'absent' };
}

async function apply(
  surfaces: AgentRegistryWriterSurfaces,
  intents: AgentIntegrationsApplyRequest['intents'],
  states: Record<string, SurfaceState>,
  projectDir: string | null = PROJECT,
) {
  return applyIntents(
    { intents },
    { surfaces, projectDir, snapshot: async () => snapshotWith(states) },
  );
}

function actionFor(
  report: Awaited<ReturnType<typeof applyIntents>>['report'],
  satisfierId: string,
) {
  return report.actions.find((entry) => entry.satisfierId === satisfierId);
}

describe('applyIntents on the desktop host', () => {
  test('a project MCP intent runs the project MCP writer', async () => {
    const surfaces = makeSurfaces();

    const { report } = await apply(surfaces, [want(CLAUDE_PROJECT_MCP)], {
      [CLAUDE_PROJECT_MCP]: 'absent',
    });

    expect(surfaces.calls.projectWrites).toEqual([
      { id: 'claude', path: `${PROJECT}/claude.config` },
    ]);
    expect(actionFor(report, CLAUDE_PROJECT_MCP)?.action).toBe('written');
  });

  test('a user MCP intent runs the user-global writer', async () => {
    const surfaces = makeSurfaces();

    const { report } = await apply(surfaces, [want(CLAUDE_USER_MCP)], {
      [CLAUDE_USER_MCP]: 'absent',
    });

    expect(surfaces.calls.userWrites).toEqual(['claude']);
    expect(actionFor(report, CLAUDE_USER_MCP)?.action).toBe('written');
  });

  test('a shared workspace file is written through the editor that owns it', async () => {
    const surfaces = makeSurfaces();

    await apply(surfaces, [want(COPILOT_PROJECT_MCP), want(CLAUDE_PROJECT_MCP)], {
      [COPILOT_PROJECT_MCP]: 'absent',
      [CLAUDE_PROJECT_MCP]: 'absent',
    });

    expect(surfaces.calls.projectWrites).toEqual([
      { id: 'claude', path: `${PROJECT}/claude.config` },
      { id: 'claude', path: `${PROJECT}/claude.config` },
    ]);
  });

  test('a prerequisite is written before the skill that needs it', async () => {
    const surfaces = makeSurfaces();

    const { report } = await apply(surfaces, [want(CLAUDE_PROJECT_SKILL)], {
      [CLAUDE_PROJECT_MCP]: 'absent',
      [CLAUDE_PROJECT_SKILL]: 'absent',
    });

    expect(surfaces.calls.projectWrites).toHaveLength(1);
    expect(surfaces.calls.skillWrites).toEqual(['claude']);
    expect(actionFor(report, CLAUDE_PROJECT_MCP)?.origin).toBeUndefined();
    expect(report.actions.map((entry) => entry.satisfierId)).toEqual([
      CLAUDE_PROJECT_MCP,
      CLAUDE_PROJECT_SKILL,
    ]);
  });

  test('one failed write does not stop the rest of the batch', async () => {
    const surfaces = makeSurfaces({ projectWriteAction: 'failed' });

    const { report } = await apply(surfaces, [want(CLAUDE_PROJECT_MCP), want(CLAUDE_USER_MCP)], {
      [CLAUDE_PROJECT_MCP]: 'absent',
      [CLAUDE_USER_MCP]: 'absent',
    });

    expect(actionFor(report, CLAUDE_PROJECT_MCP)).toMatchObject({
      action: 'failed',
      errorId: 'write-failed',
    });
    expect(actionFor(report, CLAUDE_USER_MCP)?.action).toBe('written');
  });

  test('a writer that throws is reported, and the batch still finishes', async () => {
    const surfaces = makeSurfaces({ projectWriteThrows: true });

    const { report } = await apply(surfaces, [want(CLAUDE_PROJECT_MCP), want(CLAUDE_USER_MCP)], {
      [CLAUDE_PROJECT_MCP]: 'absent',
      [CLAUDE_USER_MCP]: 'absent',
    });

    expect(actionFor(report, CLAUDE_PROJECT_MCP)).toMatchObject({
      action: 'failed',
      errorId: 'executor-threw',
    });
    expect(actionFor(report, CLAUDE_USER_MCP)?.action).toBe('written');
  });

  test('a partial failure still comes back with a fresh snapshot', async () => {
    const surfaces = makeSurfaces({ projectWriteAction: 'failed' });

    const { snapshot } = await apply(surfaces, [want(CLAUDE_PROJECT_MCP)], {
      [CLAUDE_PROJECT_MCP]: 'absent',
    });

    expect(snapshot.probes.satisfiers[CLAUDE_PROJECT_MCP]).toEqual({ state: 'absent' });
    expect(snapshot.detection.probed).toBe(true);
  });

  test('an entry OK does not own is left alone, not clobbered', async () => {
    const surfaces = makeSurfaces({ projectRemoveKind: 'left-foreign' });

    const { report } = await apply(surfaces, [drop(CLAUDE_PROJECT_MCP)], {
      [CLAUDE_PROJECT_MCP]: 'satisfied',
      [COPILOT_PROJECT_MCP]: 'absent',
    });

    expect(actionFor(report, CLAUDE_PROJECT_MCP)).toMatchObject({
      action: 'skipped-foreign',
      errorId: 'foreign-artifact',
    });
  });

  test('removing something that was never there is a no-op, not a failure', async () => {
    const surfaces = makeSurfaces({ userRemoveKind: 'not-present' });

    const { report } = await apply(surfaces, [drop(CLAUDE_USER_MCP)], {
      [CLAUDE_USER_MCP]: 'satisfied',
    });

    expect(actionFor(report, CLAUDE_USER_MCP)?.action).toBe('no-op');
  });

  test('an editor with no project surface here reports a missing surface', async () => {
    const surfaces = makeSurfaces({ projectConfigFor: ['claude'] });

    const { report } = await apply(surfaces, [want(CODEX_PROJECT_MCP)], {
      [CODEX_PROJECT_MCP]: 'absent',
    });

    expect(actionFor(report, CODEX_PROJECT_MCP)).toMatchObject({
      action: 'skipped-missing',
      errorId: 'surface-missing',
    });
    expect(surfaces.calls.projectWrites).toEqual([]);
  });

  test('a project intent with no project open never reaches a writer', async () => {
    const surfaces = makeSurfaces();

    const { report } = await apply(
      surfaces,
      [want(CLAUDE_PROJECT_MCP)],
      { [CLAUDE_PROJECT_MCP]: 'absent' },
      null,
    );

    expect(actionFor(report, CLAUDE_PROJECT_MCP)?.action).toBe('skipped-missing');
    expect(surfaces.calls.projectWrites).toEqual([]);
  });

  test('the user-global skill bundle installs into just the agent whose row it is', async () => {
    const surfaces = makeSurfaces();

    const { report } = await apply(surfaces, [want(CLAUDE_USER_SKILL)], {
      [CLAUDE_USER_SKILL]: 'absent',
    });

    expect(actionFor(report, CLAUDE_USER_SKILL)).toMatchObject({ action: 'written' });
    expect(surfaces.calls.userSkillWrites).toEqual(['claude']);
    expect(surfaces.calls.skillWrites).toEqual([]);
  });

  test('a landed user-skill install records the decision the launch reclaim reads', async () => {
    const surfaces = makeSurfaces();

    await apply(surfaces, [want(CLAUDE_USER_SKILL)], { [CLAUDE_USER_SKILL]: 'absent' });

    expect(surfaces.calls.userSkillDecisions).toEqual([true]);
  });

  test('a removal that leaves a copy behind records nothing', async () => {
    const surfaces = makeSurfaces({ userSkillPresentAnywhere: true });

    await apply(surfaces, [drop(CLAUDE_USER_SKILL)], { [CLAUDE_USER_SKILL]: 'satisfied' });

    expect(surfaces.calls.userSkillDecisions).toEqual([]);
  });

  test('a removal that empties the last copy records false', async () => {
    const surfaces = makeSurfaces({ userSkillPresentAnywhere: false });

    await apply(surfaces, [drop(CLAUDE_USER_SKILL)], { [CLAUDE_USER_SKILL]: 'satisfied' });

    expect(surfaces.calls.userSkillDecisions).toEqual([false]);
  });

  test('a failed user-skill write reports failed and does not record a decision', async () => {
    const surfaces = makeSurfaces({ userSkillWriteAction: 'failed' });

    const { report } = await apply(surfaces, [want(CLAUDE_USER_SKILL)], {
      [CLAUDE_USER_SKILL]: 'absent',
    });

    expect(actionFor(report, CLAUDE_USER_SKILL)).toMatchObject({
      action: 'failed',
      errorId: 'write-failed',
    });
    expect(surfaces.calls.userSkillDecisions).toEqual([]);
  });

  test('a unanimous project-skill batch records the decision the reclaim reads', async () => {
    const surfaces = makeSurfaces();

    await apply(surfaces, [drop(CLAUDE_PROJECT_SKILL), drop(CODEX_PROJECT_SKILL)], {
      [CLAUDE_PROJECT_SKILL]: 'satisfied',
      [CODEX_PROJECT_SKILL]: 'satisfied',
      [CLAUDE_PROJECT_MCP]: 'satisfied',
      [CODEX_PROJECT_MCP]: 'satisfied',
    });
  });

  test('a batch that disagrees about the project skill records no decision', async () => {
    const surfaces = makeSurfaces();

    await apply(surfaces, [want(CLAUDE_PROJECT_SKILL), drop(CODEX_PROJECT_SKILL)], {
      [CLAUDE_PROJECT_SKILL]: 'absent',
      [CODEX_PROJECT_SKILL]: 'satisfied',
      [CLAUDE_PROJECT_MCP]: 'satisfied',
      [CODEX_PROJECT_MCP]: 'satisfied',
    });
  });

  test('a batch with no project-skill row leaves the recorded decision alone', async () => {
    const surfaces = makeSurfaces();

    await apply(surfaces, [want(CLAUDE_PROJECT_MCP)], { [CLAUDE_PROJECT_MCP]: 'absent' });
  });

  test('re-running the same Save touches nothing the second time', async () => {
    const surfaces = makeSurfaces();

    await apply(surfaces, [want(CLAUDE_PROJECT_MCP)], { [CLAUDE_PROJECT_MCP]: 'satisfied' });

    expect(surfaces.calls.projectWrites).toEqual([]);
    expect(surfaces.calls.projectRemovals).toEqual([]);
  });

  test('a removal that would strand a peer is withheld rather than written', async () => {
    const surfaces = makeSurfaces();

    const { report } = await apply(surfaces, [drop(CLAUDE_PROJECT_MCP)], {
      [CLAUDE_PROJECT_MCP]: 'satisfied',
      [COPILOT_PROJECT_MCP]: 'satisfied',
    });

    expect(report.conflicts.map((conflict) => conflict.kind)).toContain('unresolved-shared-copy');
    expect(surfaces.calls.projectRemovals).toEqual([]);
    expect(report.withheld).toContain(CLAUDE_PROJECT_MCP);
  });

  test('an unknown satisfier is a conflict, not a crash', async () => {
    const surfaces = makeSurfaces();

    const { report } = await apply(surfaces, [want('not/a/real/satisfier')], {});

    expect(report.conflicts.map((conflict) => conflict.kind)).toEqual(['unknown-satisfier']);
    expect(report.actions).toEqual([]);
  });

  test('an empty batch is a no-op', async () => {
    const surfaces = makeSurfaces();

    const { report } = await apply(surfaces, [], {});

    expect(report).toEqual({ actions: [], conflicts: [], withheld: [] });
  });
});

function delegateFor(
  surfaces: AgentRegistryWriterSurfaces,
  opts: {
    available?: boolean;
    projectDir?: string | null;
    states?: Record<string, SurfaceState>;
    snapshot?: () => Promise<HostSnapshot>;
  } = {},
) {
  const delegate = createAgentIntegrationsApplyDelegate({
    available: opts.available ?? true,
    surfaces,
    resolveProjectDir: () => (opts.projectDir === undefined ? PROJECT : opts.projectDir),
    snapshot: opts.snapshot ?? (async () => snapshotWith(opts.states ?? {})),
  });
  return (request: AgentIntegrationsApplyRequest): Promise<AgentIntegrationsApplyResult> =>
    delegate(EVENT, request);
}

describe('the batch arm of the AI-tools channel', () => {
  test('a clean batch resolves ok with its report and snapshot', async () => {
    const surfaces = makeSurfaces();
    const apply = delegateFor(surfaces, { states: { [CLAUDE_PROJECT_MCP]: 'absent' } });

    const result = await apply({ intents: [want(CLAUDE_PROJECT_MCP)] });

    expect(result.ok).toBe(true);
    expect(result.report.actions).toHaveLength(1);
    expect(result.snapshot.detection.probed).toBe(true);
  });

  test('a failed item resolves not-ok but still carries the report and snapshot', async () => {
    const surfaces = makeSurfaces({ projectWriteAction: 'failed' });
    const apply = delegateFor(surfaces, { states: { [CLAUDE_PROJECT_MCP]: 'absent' } });

    const result = await apply({ intents: [want(CLAUDE_PROJECT_MCP)] });

    expect(result.ok).toBe(false);
    expect(result.report.actions[0]?.errorId).toBe('write-failed');
    expect(result.snapshot.probes.satisfiers[CLAUDE_PROJECT_MCP]).toEqual({ state: 'absent' });
  });

  test('an unavailable build refuses to write anything', async () => {
    const surfaces = makeSurfaces();
    const apply = delegateFor(surfaces, {
      available: false,
      states: { [CLAUDE_PROJECT_MCP]: 'absent' },
    });

    const result = await apply({ intents: [want(CLAUDE_PROJECT_MCP)] });

    expect(result).toMatchObject({ ok: false, unavailable: true });
    expect(surfaces.calls.projectWrites).toEqual([]);
  });

  test('a snapshot that cannot be taken claims nothing rather than guessing', async () => {
    const surfaces = makeSurfaces();
    const apply = delegateFor(surfaces, {
      snapshot: async () => {
        throw new Error('probe exploded');
      },
    });

    const result = await apply({ intents: [want(CLAUDE_PROJECT_MCP)] });

    expect(result.snapshot.detection).toEqual({ detected: [], probed: false });
    expect(result.snapshot.probes.satisfiers).toEqual({});
  });
});
