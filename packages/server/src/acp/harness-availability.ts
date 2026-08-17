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
  preflight: typeof preflightLaunch = preflightLaunch,
): Promise<HarnessAvailability> {
  const launch = {
    cmd: HARNESS_BINS[cli],
    args: [],
    env: mergedEnv(),
    kind: 'custom' as const,
    pathFromOverlay: false,
  };
  try {
    await preflight(launch);
    return 'present';
  } catch (err) {
    if (!(err instanceof AgentLaunchError) || err.code !== 'command-not-found') {
      // Presence was never verified either way — a silent degradation here
      // makes a wrong default undiagnosable in the field, so leave a trace.
      getLogger('acp-harness').warn(
        { cli, err },
        'harness preflight failed before absence could be verified; availability unknown',
      );
      return 'unknown';
    }
    // Same second chance the launch chain takes, and deliberately the same
    // shared provider: reporting `not-found` for a harness that
    // `ensureLaunchable` would go on to start is worse than no signal at all,
    // because it steers defaulting away from an agent that works.
    let loginShellPath: string | null = null;
    let captureErr: unknown;
    try {
      loginShellPath = await resolveLoginShellPath();
    } catch (resolveErr) {
      captureErr = resolveErr;
    }
    if (loginShellPath === null) {
      // Capture failure ≠ absence: without the login-shell PATH the second
      // chance never ran, so a `not-found` here would be a positive absence
      // claim off an unverified state. Carry the capture failure's cause —
      // this is a degradation path and must name why it degraded.
      getLogger('acp-harness').warn(
        { cli, err: captureErr },
        'login-shell PATH capture failed; harness absence unverified — availability unknown',
      );
      return 'unknown';
    }
    try {
      await preflight(withLoginShellPath(launch, loginShellPath));
      return 'present';
    } catch (secondErr) {
      if (secondErr instanceof AgentLaunchError && secondErr.code === 'command-not-found') {
        return 'not-found';
      }
      getLogger('acp-harness').warn(
        { cli, err: secondErr },
        'harness preflight on the login-shell PATH failed before absence could be verified; availability unknown',
      );
      return 'unknown';
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
    /** Test seam: the launch preflight is otherwise environment-dependent. */
    preflight?: typeof preflightLaunch;
  } = {},
): () => Promise<AcpHarnessAvailability> {
  const resolveLoginShellPath =
    opts.resolveLoginShellPath ?? getSharedLoginShellPathProvider(getLogger('acp-harness'));
  const preflight = opts.preflight ?? preflightLaunch;
  const probe =
    opts.probe ?? ((cli: AcpHarnessCli) => detectHarness(cli, resolveLoginShellPath, preflight));
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
        } catch (err) {
          getLogger('acp-harness').warn(
            { cli, err },
            'harness availability probe rejected; availability unknown',
          );
          return [cli, 'unknown'] as const;
        }
      }),
    ).then((entries) => Object.fromEntries(entries) as AcpHarnessAvailability);
    cached = { expiresAt: timestamp + ttlMs, value };
    return value;
  };
}
