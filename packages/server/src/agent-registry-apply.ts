import {
  type ApplyReport,
  buildConnectionsView,
  EMPTY_DETECTION_SNAPSHOT,
  type EnvTier,
  emptyProbeSnapshot,
  executePlan,
  type HostSnapshot,
  type ProbeResolver,
  planIntents,
  type SatisfierId,
  type StepExecutor,
} from '@inkeep/open-knowledge-core';
import { getLogger } from './logger.ts';
import { BUNDLE_SKILL_NAME } from './skill-bundles.ts';
import { writeBundleDecision } from './skill-state.ts';

const log = getLogger('agent-registry-apply');

export interface AgentRegistryHostSeam {
  readonly execute?: StepExecutor;
  readonly probe?: ProbeResolver;
  readonly userSkillPresentAnywhere?: (home: string) => boolean;
}

function emptyHostSnapshot(env: EnvTier): HostSnapshot {
  return { probes: emptyProbeSnapshot(env), detection: EMPTY_DETECTION_SNAPSHOT };
}

export const NO_WRITER_EXECUTOR: StepExecutor = () => ({
  action: 'skipped-unsupported',
  errorId: 'no-writer',
});

export interface AgentRegistryIntentInput {
  readonly satisfierId?: unknown;
  readonly desired?: unknown;
}

export interface AgentRegistryApplyOptions {
  readonly execute?: StepExecutor;
  readonly snapshot: () => Promise<HostSnapshot>;
  readonly env: EnvTier;
  readonly decisionHome: string;
  readonly userSkillPresentAnywhere?: (home: string) => boolean;
  readonly projectDir?: string | null;
}

async function safeSnapshot(
  take: () => Promise<HostSnapshot>,
  env: EnvTier,
): Promise<HostSnapshot> {
  try {
    return await take();
  } catch (err) {
    log.warn({ err }, 'host snapshot failed; claiming nothing');
    return emptyHostSnapshot(env);
  }
}

export async function applyAgentRegistryIntents(
  intents: readonly AgentRegistryIntentInput[],
  options: AgentRegistryApplyOptions,
): Promise<{ report: ApplyReport; snapshot: HostSnapshot }> {
  const before = await safeSnapshot(options.snapshot, options.env);
  const view = buildConnectionsView({ probes: before.probes, detection: before.detection });

  const plan = planIntents(
    intents.map((intent) => ({
      satisfierId: intent?.satisfierId as SatisfierId,
      desired: intent?.desired as 'present' | 'absent',
    })),
    view,
  );

  const report = await executePlan(plan, options.execute ?? NO_WRITER_EXECUTOR);

  const { decisionHome } = options;
  const userSkill = userSkillOutcome(report);
  const record =
    userSkill === 'installed'
      ? true
      : userSkill === 'removed' &&
          options.userSkillPresentAnywhere !== undefined &&
          !options.userSkillPresentAnywhere(decisionHome)
        ? false
        : null;
  if (record !== null) {
    await writeBundleDecision(decisionHome, BUNDLE_SKILL_NAME.discovery, record).catch(
      (err: unknown) => {
        log.warn({ err }, 'user-skill decision not recorded');
      },
    );
  }

  return { report, snapshot: await safeSnapshot(options.snapshot, options.env) };
}

function userSkillOutcome(report: ApplyReport): 'installed' | 'removed' | null {
  const steps = report.actions.filter(
    (action) => action.piece === 'skill' && action.scope === 'user',
  );
  if (steps.some((s) => s.action === 'written' || s.action === 'overwritten')) return 'installed';
  if (steps.some((s) => s.action === 'removed')) return 'removed';
  return null;
}
