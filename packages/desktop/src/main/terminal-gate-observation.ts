import { agentIdForTerminalCli, type HostSnapshot } from '@inkeep/open-knowledge-core';
import { observeReadiness, type ReadinessObservationLogger } from '@inkeep/open-knowledge-server';

export interface TerminalGateObservationOptions {
  readonly launchCli: string;
  readonly projectRoot: string;
  readonly log: ReadinessObservationLogger;
  readonly snapshot: (projectRoot: string) => Promise<HostSnapshot>;
}

export async function observeTerminalLaunch(
  options: TerminalGateObservationOptions,
): Promise<void> {
  await observeReadiness({
    site: 'terminal',
    agentId: agentIdForTerminalCli(options.launchCli) ?? options.launchCli,
    mode: 'terminal',
    log: options.log,
    snapshot: () => options.snapshot(options.projectRoot),
  });
}
