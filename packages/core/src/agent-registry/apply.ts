import type { AgentId, IntegrationPiece, PathId, SatisfierId, SatisfierScope } from './ids.ts';
import type { IntentDesire, IntentPlan, PlanConflict, PlannedStep } from './intents.ts';
import { APPLY_ACTIONS, type ApplyAction, type SatisfierKind } from './vocabulary.ts';

export const APPLY_ERROR_IDS = [
  'not-installable',
  'no-writer',
  'surface-missing',
  'foreign-artifact',
  'write-declined',
  'write-failed',
  'executor-threw',
  'unrecognized-outcome',
  'dependency-failed',
] as const;

export type ApplyErrorId = (typeof APPLY_ERROR_IDS)[number];

export interface ExecutedOutcome {
  readonly action: ApplyAction;
  readonly errorId?: ApplyErrorId;
}

export type StepExecutor = (step: PlannedStep) => ExecutedOutcome | Promise<ExecutedOutcome>;

export interface AppliedStep {
  readonly satisfierId: SatisfierId;
  readonly agentId: AgentId;
  readonly piece: IntegrationPiece;
  readonly scope: SatisfierScope;
  readonly kind: SatisfierKind;
  readonly pathId?: PathId;
  readonly desired: IntentDesire;
  readonly action: ApplyAction;
  readonly errorId?: ApplyErrorId;
}

export interface ApplyReport {
  readonly actions: readonly AppliedStep[];
  readonly conflicts: readonly PlanConflict[];
  readonly withheld: readonly SatisfierId[];
}

const SETTLED_ACTIONS: readonly ApplyAction[] = [
  'written',
  'overwritten',
  'removed',
  'unchanged',
  'no-op',
];

const APPLY_ACTION_VALUES = new Set<string>(APPLY_ACTIONS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readOutcome(value: unknown): ExecutedOutcome | null {
  if (!isRecord(value)) return null;
  const { action, errorId } = value as { action?: unknown; errorId?: unknown };
  if (typeof action !== 'string' || !APPLY_ACTION_VALUES.has(action)) return null;
  const id =
    typeof errorId === 'string' && (APPLY_ERROR_IDS as readonly string[]).includes(errorId)
      ? (errorId as ApplyErrorId)
      : undefined;
  return id === undefined
    ? { action: action as ApplyAction }
    : { action: action as ApplyAction, errorId: id };
}

function describe(step: PlannedStep, outcome: ExecutedOutcome): AppliedStep {
  return {
    satisfierId: step.satisfierId,
    agentId: step.agentId,
    piece: step.piece,
    scope: step.scope,
    kind: step.kind,
    ...(step.pathId === undefined ? {} : { pathId: step.pathId }),
    desired: step.desired,
    action: outcome.action,
    ...(outcome.errorId === undefined ? {} : { errorId: outcome.errorId }),
  };
}

async function runStep(execute: StepExecutor, step: PlannedStep): Promise<ExecutedOutcome> {
  if (step.alreadyInDesiredState) return { action: 'unchanged' };
  if (step.installability === 'not-installable') {
    return { action: 'skipped-unsupported', errorId: 'not-installable' };
  }
  if (step.installability === 'user-completes') return { action: 'handed-off' };

  let raw: unknown;
  try {
    raw = await execute(step);
  } catch {
    return { action: 'failed', errorId: 'executor-threw' };
  }
  return readOutcome(raw) ?? { action: 'failed', errorId: 'unrecognized-outcome' };
}

export async function executePlan(
  plan: IntentPlan | null | undefined,
  execute: StepExecutor,
): Promise<ApplyReport> {
  const steps = isRecord(plan) && Array.isArray(plan.steps) ? plan.steps : [];
  const conflicts = isRecord(plan) && Array.isArray(plan.conflicts) ? plan.conflicts : [];
  const planWithheld = isRecord(plan) && Array.isArray(plan.withheld) ? plan.withheld : [];

  const actions: AppliedStep[] = [];
  const unsettled = new Set<SatisfierId>();

  for (const step of steps) {
    if (!isRecord(step) || typeof step.satisfierId !== 'string') continue;
    const planned = step as unknown as PlannedStep;

    if (planned.dependsOn.some((id) => unsettled.has(id))) {
      unsettled.add(planned.satisfierId);
      actions.push(
        describe(planned, { action: 'skipped-prerequisite', errorId: 'dependency-failed' }),
      );
      continue;
    }

    const outcome = await runStep(execute, planned);
    if (!SETTLED_ACTIONS.includes(outcome.action)) unsettled.add(planned.satisfierId);
    actions.push(describe(planned, outcome));
  }

  return { actions, conflicts, withheld: planWithheld };
}
