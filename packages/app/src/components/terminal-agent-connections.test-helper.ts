import {
  AGENT_REGISTRY,
  type HostSnapshot,
  type SatisfierProbe,
  type TerminalCli,
} from '@inkeep/open-knowledge-core';

export function terminalAgentSnapshot(connected: readonly TerminalCli[] = []): HostSnapshot {
  return {
    probes: {
      env: 'desktop',
      satisfiers: Object.fromEntries(
        Object.values(AGENT_REGISTRY).flatMap((agent) =>
          agent.satisfiers
            .filter((satisfier) => satisfier.probe.mode === 'probeable')
            .map((satisfier): readonly [string, SatisfierProbe] => [
              satisfier.id,
              {
                state:
                  satisfier.piece === 'mcp' && connected.some((cli) => cli === agent.id)
                    ? 'satisfied'
                    : 'absent',
              },
            ]),
        ),
      ),
    },
    detection: { detected: [], probed: true },
  };
}
