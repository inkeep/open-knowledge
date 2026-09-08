import {
  type AgentMode,
  assessReadiness,
  type HostSnapshot,
  type ReadinessAssessment,
  type ReadinessLogSite,
  summarizeReadinessForLog,
} from '@inkeep/open-knowledge-core';

export interface ReadinessObservationLogger {
  info(data: unknown, message: string): void;
  warn(data: unknown, message: string): void;
}

export interface ObserveReadinessInput {
  readonly site: ReadinessLogSite;
  readonly agentId: string;
  readonly mode: AgentMode;
  readonly log: ReadinessObservationLogger;
  readonly snapshot?: () => Promise<HostSnapshot>;
}

export async function observeReadiness(
  input: ObserveReadinessInput,
): Promise<ReadinessAssessment | null> {
  try {
    const host = input.snapshot === undefined ? null : await input.snapshot();
    const assessment = assessReadiness({
      agentId: input.agentId,
      mode: input.mode,
      probes: host?.probes ?? null,
      detection: host?.detection ?? null,
    });
    input.log.info(summarizeReadinessForLog(input.site, assessment), '[agent-gate] readiness');
    return assessment;
  } catch (err) {
    input.log.warn(
      { err, site: input.site, mode: input.mode },
      '[agent-gate] readiness could not be assessed',
    );
    return null;
  }
}
