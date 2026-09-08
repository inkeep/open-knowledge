import { describe, expect, test } from 'vitest';
import { type ApplyErrorId, type ExecutedOutcome, executePlan } from './apply.ts';
import { buildConnectionsView } from './connections.ts';
import type { SatisfierId } from './ids.ts';
import { type ApplyIntent, type IntentPlan, type PlannedStep, planIntents } from './intents.ts';
import type { ProbeSnapshot } from './snapshot.ts';
import type { ApplyAction, SurfaceState } from './vocabulary.ts';

const CLAUDE_PROJECT_MCP = 'claude/mcp/project/config-entry' as SatisfierId;
const CLAUDE_PROJECT_SKILL = 'claude/skill/project/skill-bundle-copy' as SatisfierId;
const CLAUDE_USER_MCP = 'claude/mcp/user/config-entry' as SatisfierId;
const COPILOT_PROJECT_MCP = 'copilot/mcp/project/config-entry' as SatisfierId;
const LM_STUDIO_USER_MCP = 'lm-studio/mcp/user/config-entry' as SatisfierId;

function probesWith(states: Record<string, SurfaceState>): ProbeSnapshot {
  return {
    env: 'desktop',
    satisfiers: Object.fromEntries(Object.entries(states).map(([id, state]) => [id, { state }])),
  };
}

function planWith(intents: ApplyIntent[], states: Record<string, SurfaceState> = {}): IntentPlan {
  return planIntents(
    intents,
    buildConnectionsView({
      probes: probesWith(states),
      detection: {
        detected: [...new Set(intents.map((i) => i.satisfierId.split('/')[0]))] as never,
        probed: true,
      },
    }),
  );
}

function want(id: SatisfierId): ApplyIntent {
  return { satisfierId: id, desired: 'present' };
}

function drop(id: SatisfierId): ApplyIntent {
  return { satisfierId: id, desired: 'absent' };
}

function actionFor(
  report: Awaited<ReturnType<typeof executePlan>>,
  id: SatisfierId,
): { action: ApplyAction; errorId?: ApplyErrorId } | undefined {
  const found = report.actions.find((entry) => entry.satisfierId === id);
  return found === undefined
    ? undefined
    : { action: found.action, ...(found.errorId === undefined ? {} : { errorId: found.errorId }) };
}

function recordingExecutor(answer: (step: PlannedStep) => ExecutedOutcome) {
  const seen: SatisfierId[] = [];
  return {
    seen,
    execute: (step: PlannedStep): ExecutedOutcome => {
      seen.push(step.satisfierId);
      return answer(step);
    },
  };
}

const WROTE: ExecutedOutcome = { action: 'written' };

describe('executePlan', () => {
  test('runs an ordered plan and reports one action per step', async () => {
    const plan = planWith([want(CLAUDE_PROJECT_SKILL)], {
      [CLAUDE_PROJECT_MCP]: 'absent',
      [CLAUDE_PROJECT_SKILL]: 'absent',
    });
    const executor = recordingExecutor(() => WROTE);

    const report = await executePlan(plan, executor.execute);

    expect(report.actions.map((entry) => entry.satisfierId)).toEqual(
      plan.steps.map((step) => step.satisfierId),
    );
    expect(report.actions.every((entry) => entry.action === 'written')).toBe(true);
  });

  test('runs prerequisites before the work that needs them', async () => {
    const plan = planWith([want(CLAUDE_PROJECT_SKILL)], {
      [CLAUDE_PROJECT_MCP]: 'absent',
      [CLAUDE_PROJECT_SKILL]: 'absent',
    });
    const executor = recordingExecutor(() => WROTE);

    await executePlan(plan, executor.execute);

    expect(executor.seen).toEqual([CLAUDE_PROJECT_MCP, CLAUDE_PROJECT_SKILL]);
  });

  test('carries the step identity onto its action so a row can be found again', async () => {
    const plan = planWith([want(CLAUDE_PROJECT_MCP)], { [CLAUDE_PROJECT_MCP]: 'absent' });

    const report = await executePlan(plan, () => WROTE);

    expect(report.actions[0]).toMatchObject({
      satisfierId: CLAUDE_PROJECT_MCP,
      agentId: 'claude',
      piece: 'mcp',
      scope: 'project',
      kind: 'config-entry',
      pathId: 'editor-project-config:claude',
      desired: 'present',
      action: 'written',
    });
  });

  test('a failed write does not stop the batch', async () => {
    const plan = planWith([want(CLAUDE_USER_MCP), want(CLAUDE_PROJECT_MCP)], {
      [CLAUDE_USER_MCP]: 'absent',
      [CLAUDE_PROJECT_MCP]: 'absent',
    });

    const report = await executePlan(plan, (step) =>
      step.satisfierId === CLAUDE_USER_MCP ? { action: 'failed', errorId: 'write-failed' } : WROTE,
    );

    expect(actionFor(report, CLAUDE_USER_MCP)).toEqual({
      action: 'failed',
      errorId: 'write-failed',
    });
    expect(actionFor(report, CLAUDE_PROJECT_MCP)).toEqual({ action: 'written' });
  });

  test('an executor that throws becomes a failed item, not a thrown batch', async () => {
    const plan = planWith([want(CLAUDE_USER_MCP), want(CLAUDE_PROJECT_MCP)], {
      [CLAUDE_USER_MCP]: 'absent',
      [CLAUDE_PROJECT_MCP]: 'absent',
    });

    const report = await executePlan(plan, (step) => {
      if (step.satisfierId === CLAUDE_USER_MCP) throw new Error('disk on fire');
      return WROTE;
    });

    expect(actionFor(report, CLAUDE_USER_MCP)).toEqual({
      action: 'failed',
      errorId: 'executor-threw',
    });
    expect(actionFor(report, CLAUDE_PROJECT_MCP)).toEqual({ action: 'written' });
  });

  test('an unusable answer is a failure, never a silent success', async () => {
    const plan = planWith([want(CLAUDE_PROJECT_MCP)], { [CLAUDE_PROJECT_MCP]: 'absent' });

    const report = await executePlan(plan, () => ({ action: 'wrote-it' }) as never);

    expect(actionFor(report, CLAUDE_PROJECT_MCP)).toEqual({
      action: 'failed',
      errorId: 'unrecognized-outcome',
    });
  });

  test('an error id the vocabulary does not carry is dropped, not passed through', async () => {
    const plan = planWith([want(CLAUDE_PROJECT_MCP)], { [CLAUDE_PROJECT_MCP]: 'absent' });

    const report = await executePlan(
      plan,
      () => ({ action: 'failed', errorId: '/Users/mike/secret/path' }) as never,
    );

    expect(actionFor(report, CLAUDE_PROJECT_MCP)).toEqual({ action: 'failed' });
  });

  test('work whose prerequisite failed is skipped rather than attempted', async () => {
    const plan = planWith([want(CLAUDE_PROJECT_SKILL)], {
      [CLAUDE_PROJECT_MCP]: 'absent',
      [CLAUDE_PROJECT_SKILL]: 'absent',
    });
    const executor = recordingExecutor((step) =>
      step.satisfierId === CLAUDE_PROJECT_MCP
        ? { action: 'failed', errorId: 'write-failed' }
        : WROTE,
    );

    const report = await executePlan(plan, executor.execute);

    expect(executor.seen).toEqual([CLAUDE_PROJECT_MCP]);
    expect(actionFor(report, CLAUDE_PROJECT_SKILL)).toEqual({
      action: 'skipped-prerequisite',
      errorId: 'dependency-failed',
    });
  });

  test('a declined project config skips the project skill that depends on it', async () => {
    const plan = planWith([want(CLAUDE_PROJECT_SKILL)], {
      [CLAUDE_PROJECT_MCP]: 'absent',
      [CLAUDE_PROJECT_SKILL]: 'absent',
    });

    const report = await executePlan(plan, (step) =>
      step.satisfierId === CLAUDE_PROJECT_MCP
        ? { action: 'declined', errorId: 'write-declined' }
        : WROTE,
    );

    expect(actionFor(report, CLAUDE_PROJECT_SKILL)?.action).toBe('skipped-prerequisite');
  });

  test('a handed-off prerequisite blocks its dependent — nobody clicked yet', async () => {
    const plan = planWith([want(CLAUDE_PROJECT_SKILL)], {
      [CLAUDE_PROJECT_MCP]: 'absent',
      [CLAUDE_PROJECT_SKILL]: 'absent',
    });

    const report = await executePlan(plan, (step) =>
      step.satisfierId === CLAUDE_PROJECT_MCP ? { action: 'handed-off' } : WROTE,
    );

    expect(actionFor(report, CLAUDE_PROJECT_SKILL)?.action).toBe('skipped-prerequisite');
  });

  test('an artifact already in the requested state is left untouched', async () => {
    const plan = planWith([want(CLAUDE_PROJECT_MCP)], { [CLAUDE_PROJECT_MCP]: 'satisfied' });
    const executor = recordingExecutor(() => WROTE);

    const report = await executePlan(plan, executor.execute);

    expect(executor.seen).toEqual([]);
    expect(actionFor(report, CLAUDE_PROJECT_MCP)).toEqual({ action: 'unchanged' });
  });

  test('re-running the same Save writes nothing the second time', async () => {
    const first = planWith([want(CLAUDE_PROJECT_MCP)], { [CLAUDE_PROJECT_MCP]: 'absent' });
    const firstRun = recordingExecutor(() => WROTE);
    await executePlan(first, firstRun.execute);

    const second = planWith([want(CLAUDE_PROJECT_MCP)], { [CLAUDE_PROJECT_MCP]: 'satisfied' });
    const secondRun = recordingExecutor(() => WROTE);
    const report = await executePlan(second, secondRun.execute);

    expect(firstRun.seen).toEqual([CLAUDE_PROJECT_MCP]);
    expect(secondRun.seen).toEqual([]);
    expect(actionFor(report, CLAUDE_PROJECT_MCP)).toEqual({ action: 'unchanged' });
  });

  test('something OK cannot install is never handed to a writer', async () => {
    const plan = planWith([want(LM_STUDIO_USER_MCP)], { [LM_STUDIO_USER_MCP]: 'absent' });
    const executor = recordingExecutor(() => WROTE);

    const report = await executePlan(plan, executor.execute);

    expect(executor.seen).toEqual([]);
    expect(actionFor(report, LM_STUDIO_USER_MCP)).toEqual({
      action: 'skipped-unsupported',
      errorId: 'not-installable',
    });
  });

  test('a plan whose only step is unwritable still reports that step', async () => {
    const plan = planWith([want(LM_STUDIO_USER_MCP)], { [LM_STUDIO_USER_MCP]: 'absent' });

    const report = await executePlan(plan, () => WROTE);

    expect(report.actions).toHaveLength(1);
    expect(report.conflicts).toEqual([]);
  });

  test('conflicts and withheld work survive into the report', async () => {
    const plan = planWith([drop(COPILOT_PROJECT_MCP)], {
      [COPILOT_PROJECT_MCP]: 'satisfied',
      [CLAUDE_PROJECT_MCP]: 'satisfied',
    });

    const report = await executePlan(plan, () => WROTE);

    expect(report.conflicts.map((conflict) => conflict.kind)).toContain('unresolved-shared-copy');
    expect(report.withheld).toContain(COPILOT_PROJECT_MCP);
    expect(report.actions).toEqual([]);
  });

  test('an empty plan is a no-op, not a failure', async () => {
    const report = await executePlan(planIntents([], buildConnectionsView()), () => WROTE);

    expect(report).toEqual({ actions: [], conflicts: [], withheld: [] });
  });

  test('a plan that never arrived is treated as empty', async () => {
    await expect(executePlan(undefined, () => WROTE)).resolves.toEqual({
      actions: [],
      conflicts: [],
      withheld: [],
    });
    await expect(executePlan(null, () => WROTE)).resolves.toEqual({
      actions: [],
      conflicts: [],
      withheld: [],
    });
  });

  test('an async executor is awaited before the next step runs', async () => {
    const plan = planWith([want(CLAUDE_PROJECT_SKILL)], {
      [CLAUDE_PROJECT_MCP]: 'absent',
      [CLAUDE_PROJECT_SKILL]: 'absent',
    });
    const order: string[] = [];

    await executePlan(plan, async (step) => {
      order.push(`start:${step.satisfierId}`);
      await Promise.resolve();
      order.push(`end:${step.satisfierId}`);
      return WROTE;
    });

    expect(order).toEqual([
      `start:${CLAUDE_PROJECT_MCP}`,
      `end:${CLAUDE_PROJECT_MCP}`,
      `start:${CLAUDE_PROJECT_SKILL}`,
      `end:${CLAUDE_PROJECT_SKILL}`,
    ]);
  });

  test('a removal reports what it removed', async () => {
    const plan = planWith([drop(CLAUDE_USER_MCP)], { [CLAUDE_USER_MCP]: 'satisfied' });

    const report = await executePlan(plan, () => ({ action: 'removed' }));

    expect(actionFor(report, CLAUDE_USER_MCP)).toEqual({ action: 'removed' });
  });
});
