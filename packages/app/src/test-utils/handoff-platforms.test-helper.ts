import type * as AgentRegistry from '@inkeep/open-knowledge-core/agent-registry';
import type { HandoffTarget, TargetData } from '@inkeep/open-knowledge-core/handoff';

type HostPlatforms = ReadonlyArray<AgentRegistry.HandoffHostPlatform>;

const restrictedPlatforms = new Map<HandoffTarget, HostPlatforms>();

export function restrictHandoffTargetPlatforms(
  restrictions: Partial<Record<HandoffTarget, HostPlatforms>>,
): void {
  restrictedPlatforms.clear();
  for (const [targetId, platforms] of Object.entries(restrictions)) {
    if (platforms !== undefined) restrictedPlatforms.set(targetId as HandoffTarget, platforms);
  }
}

function withRestrictedPlatforms<T extends object>(
  facet: T,
  targetId: HandoffTarget,
  declared: HostPlatforms,
): T {
  return Object.defineProperty({ ...facet }, 'platforms', {
    enumerable: true,
    get: () => restrictedPlatforms.get(targetId) ?? declared,
  });
}

export function withRestrictableHandoffPlatforms(
  actual: typeof AgentRegistry,
): typeof AgentRegistry {
  const registry = Object.fromEntries(
    Object.entries(actual.AGENT_REGISTRY).map(([agentId, record]) => {
      const external = record.external;
      if (external === undefined) return [agentId, record];
      return [
        agentId,
        {
          ...record,
          external: withRestrictedPlatforms(external, external.targetId, external.platforms),
        },
      ];
    }),
  ) as typeof actual.AGENT_REGISTRY;
  return {
    ...actual,
    AGENT_REGISTRY: registry,
    VISIBLE_HANDOFF_TARGETS: actual.VISIBLE_HANDOFF_TARGETS.map((target: TargetData) =>
      withRestrictedPlatforms(target, target.id, target.platforms),
    ),
  };
}
