/**
 * Local harness detection for registry-backed ACP agents.
 *
 * The ACP adapter distribution and the underlying harness are different
 * things: a registry row may be runnable through npx while the corresponding
 * first-party CLI is absent. This probe is only a defaulting/presentation
 * signal. Launch resolution remains authoritative.
 */

import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { getLogger } from '../logger.ts';
import { AgentLaunchError, mergedEnv, preflightLaunch, withLoginShellPath } from './launch.ts';
import { getSharedLoginShellPathProvider } from './login-shell-path.ts';

export type HarnessAvailability = 'present' | 'not-found' | 'unknown';

/**
 * Harnesses this probe knows how to look for. A superset of `TerminalCli`:
 * Gemini has a first-party CLI and a registry ACP row but no docked-terminal
 * launch recipe, and the catalog signal is worth having without inventing one.
 */
export type AcpHarnessCli = TerminalCli | 'gemini';

/** Registry agent id → the first-party CLI its adapter drives. */
export const ACP_AGENT_HARNESS_CLIS: Readonly<Record<string, AcpHarnessCli | undefined>> = {
  'claude-acp': 'claude',
  'codex-acp': 'codex',
  cursor: 'cursor',
  gemini: 'gemini',
  opencode: 'opencode',
  'pi-acp': 'pi',
};

const HARNESS_BINS: Readonly<Record<AcpHarnessCli, string>> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor-agent',
  gemini: 'gemini',
  opencode: 'opencode',
  pi: 'pi',
  antigravity: 'agy',
  copilot: 'copilot',
  openclaw: 'openclaw',
  hermes: 'hermes',
};

export type AcpHarnessAvailability = Readonly<Partial<Record<AcpHarnessCli, HarnessAvailability>>>;

const DEFAULT_TTL_MS = 60_000;

async function detectHarness(
  cli: AcpHarnessCli,
  resolveLoginShellPath: () => Promise<string | null>,
): Promise<HarnessAvailability> {
  const launch = {
    cmd: HARNESS_BINS[cli],
    args: [],
    env: mergedEnv(),
    kind: 'custom' as const,
    pathFromOverlay: false,
  };
  try {
    await preflightLaunch(launch);
    return 'present';
  } catch (err) {
    if (!(err instanceof AgentLaunchError) || err.code !== 'command-not-found') return 'unknown';
    // Same second chance the launch chain takes, and deliberately the same
    // shared provider: reporting `not-found` for a harness that
    // `ensureLaunchable` would go on to start is worse than no signal at all,
    // because it steers defaulting away from an agent that works.
    const loginShellPath = await resolveLoginShellPath().catch(() => null);
    if (loginShellPath === null) return 'not-found';
    try {
      await preflightLaunch(withLoginShellPath(launch, loginShellPath));
      return 'present';
    } catch {
      return 'not-found';
    }
  }
}

export function createAcpHarnessAvailabilityProbe(
  opts: {
    probe?: (cli: AcpHarnessCli) => Promise<HarnessAvailability>;
    now?: () => number;
    ttlMs?: number;
    /** Defaults to the process-shared probe the launch chain uses. */
    resolveLoginShellPath?: () => Promise<string | null>;
  } = {},
): () => Promise<AcpHarnessAvailability> {
  const resolveLoginShellPath =
    opts.resolveLoginShellPath ?? getSharedLoginShellPathProvider(getLogger('acp-harness'));
  const probe = opts.probe ?? ((cli: AcpHarnessCli) => detectHarness(cli, resolveLoginShellPath));
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const harnesses = [...new Set(Object.values(ACP_AGENT_HARNESS_CLIS))].filter(
    (cli): cli is AcpHarnessCli => cli !== undefined,
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
