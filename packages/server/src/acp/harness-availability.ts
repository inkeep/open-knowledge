/**
 * Local harness detection for registry-backed ACP agents.
 *
 * The ACP adapter distribution and the underlying harness are different
 * things: a registry row may be runnable through npx while the corresponding
 * first-party CLI is absent. This probe is only a defaulting/presentation
 * signal. Launch resolution remains authoritative.
 */

import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { AgentLaunchError, mergedEnv, preflightLaunch } from './launch.ts';

export type HarnessAvailability = 'present' | 'not-found' | 'unknown';

export const ACP_AGENT_HARNESS_CLIS: Readonly<Record<string, TerminalCli | undefined>> = {
  'claude-acp': 'claude',
  'codex-acp': 'codex',
  cursor: 'cursor',
  opencode: 'opencode',
};

const HARNESS_BINS: Readonly<Record<TerminalCli, string>> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor-agent',
  opencode: 'opencode',
  pi: 'pi',
  antigravity: 'agy',
  copilot: 'copilot',
  openclaw: 'openclaw',
  hermes: 'hermes',
};

export type AcpHarnessAvailability = Readonly<Partial<Record<TerminalCli, HarnessAvailability>>>;

const DEFAULT_TTL_MS = 60_000;

async function detectHarness(cli: TerminalCli): Promise<HarnessAvailability> {
  try {
    await preflightLaunch({
      cmd: HARNESS_BINS[cli],
      args: [],
      env: mergedEnv(),
      kind: 'custom',
    });
    return 'present';
  } catch (err) {
    if (err instanceof AgentLaunchError && err.code === 'command-not-found') return 'not-found';
    return 'unknown';
  }
}

export function createAcpHarnessAvailabilityProbe(
  opts: {
    probe?: (cli: TerminalCli) => Promise<HarnessAvailability>;
    now?: () => number;
    ttlMs?: number;
  } = {},
): () => Promise<AcpHarnessAvailability> {
  const probe = opts.probe ?? detectHarness;
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const harnesses = [...new Set(Object.values(ACP_AGENT_HARNESS_CLIS))].filter(
    (cli): cli is TerminalCli => cli !== undefined,
  );
  let cached: { expiresAt: number; value: Promise<AcpHarnessAvailability> } | null = null;

  return () => {
    const timestamp = now();
    if (cached !== null && cached.expiresAt > timestamp) return cached.value;
    const value = Promise.all(
      harnesses.map(async (cli) => {
        try {
          return [cli, await probe(cli)] as const;
        } catch {
          return [cli, 'unknown'] as const;
        }
      }),
    ).then((entries) => Object.fromEntries(entries) as AcpHarnessAvailability);
    cached = { expiresAt: timestamp + ttlMs, value };
    return value;
  };
}
