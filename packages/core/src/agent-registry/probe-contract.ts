import { ALL_SATISFIERS } from './agents.ts';
import type { AgentId, IntegrationPiece, PathId, SatisfierId, SatisfierScope } from './ids.ts';
import type { EnvTier, ProbeSnapshot, SatisfierProbe } from './snapshot.ts';
import type { ProbeStrictness, SatisfierKind, SurfaceState } from './vocabulary.ts';

export interface ProbeWorkItem {
  readonly satisfierId: SatisfierId;
  readonly agent: AgentId;
  readonly piece: IntegrationPiece;
  readonly scope: SatisfierScope;
  readonly kind: SatisfierKind;
  readonly pathId: PathId | null;
  readonly strictness: readonly ProbeStrictness[];
}

const WORK_ITEMS: readonly ProbeWorkItem[] = ALL_SATISFIERS.flatMap((record) =>
  record.probe.mode === 'probeable'
    ? [
        {
          satisfierId: record.id,
          agent: record.agent,
          piece: record.piece,
          scope: record.scope,
          kind: record.kind,
          pathId: record.pathId ?? null,
          strictness: record.probe.strictness,
        },
      ]
    : [],
);

export const PROBEABLE_SATISFIER_IDS: readonly SatisfierId[] = WORK_ITEMS.map(
  (item) => item.satisfierId,
);

export function planProbes(agentIds?: readonly AgentId[]): readonly ProbeWorkItem[] {
  if (agentIds === undefined) return WORK_ITEMS;
  const wanted = new Set<string>(agentIds);
  return WORK_ITEMS.filter((item) => wanted.has(item.agent));
}

export type ProbeAnswer = {
  readonly state: SurfaceState;
  readonly strictness?: readonly ProbeStrictness[];
  readonly sharedWith?: readonly AgentId[];
  readonly path?: string;
} | null;

export type ProbeResolver = (item: ProbeWorkItem) => ProbeAnswer | Promise<ProbeAnswer>;

export interface BuildProbeSnapshotInput {
  readonly env: EnvTier;
  readonly resolve: ProbeResolver;
  readonly agentIds?: readonly AgentId[];
}

async function safeResolve(resolve: ProbeResolver, item: ProbeWorkItem): Promise<ProbeAnswer> {
  try {
    return await resolve(item);
  } catch {
    return null;
  }
}

function admittedStrictness(
  item: ProbeWorkItem,
  claimed: readonly ProbeStrictness[] | undefined,
): readonly ProbeStrictness[] | undefined {
  if (claimed === undefined) return undefined;
  const admitted = claimed.filter((key) => item.strictness.includes(key));
  return admitted.length === 0 ? undefined : admitted;
}

function toProbe(item: ProbeWorkItem, answer: ProbeAnswer): SatisfierProbe {
  if (answer === null || typeof answer.state !== 'string' || answer.state.length === 0) {
    return { state: 'unprobed' };
  }
  const strictness = admittedStrictness(item, answer.strictness);
  const shared = answer.sharedWith?.filter((id) => id !== item.agent);
  const path = typeof answer.path === 'string' && answer.path.length > 0 ? answer.path : undefined;
  return {
    state: answer.state,
    ...(strictness === undefined ? {} : { strictness }),
    ...(shared === undefined || shared.length === 0 ? {} : { sharedWith: shared }),
    ...(path === undefined ? {} : { path }),
  };
}

export async function buildProbeSnapshot(input: BuildProbeSnapshotInput): Promise<ProbeSnapshot> {
  const satisfiers: Record<string, SatisfierProbe> = {};
  for (const item of planProbes(input.agentIds)) {
    satisfiers[item.satisfierId] = toProbe(item, await safeResolve(input.resolve, item));
  }
  return { env: input.env, satisfiers };
}

export async function collectProbeCoverage(
  resolve: ProbeResolver,
  agentIds?: readonly AgentId[],
): Promise<readonly SatisfierId[]> {
  const covered: SatisfierId[] = [];
  for (const item of planProbes(agentIds)) {
    if ((await safeResolve(resolve, item)) !== null) covered.push(item.satisfierId);
  }
  return covered;
}

export interface ProbeCoverageReport {
  readonly missing: readonly SatisfierId[];
  readonly unclaimed: readonly string[];
}

export function checkProbeCoverage(produced: Iterable<string>): ProbeCoverageReport {
  const claimed = new Set<string>(PROBEABLE_SATISFIER_IDS);
  const answered = new Set<string>(produced);
  return {
    missing: PROBEABLE_SATISFIER_IDS.filter((id) => !answered.has(id)),
    unclaimed: [...answered].filter((id) => !claimed.has(id)),
  };
}
