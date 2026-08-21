/**
 * Local harness detection for registry-backed ACP agents.
 *
 * The ACP adapter distribution and the underlying harness are different
 * things: a registry row may be runnable through npx while the corresponding
 * first-party CLI is absent. This probe is only a defaulting/presentation
 * signal. Launch resolution remains authoritative.
 *
 * Two independent signals per harness, deliberately kept apart rather than
 * collapsed into one verdict: whether the first-party CLI is on PATH, and
 * whether the credential namespace the adapter reads already holds a sign-in.
 * They answer different questions and a future logged-out card needs to tell
 * "no CLI here" apart from "CLI here but signed out".
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { getLogger } from '../logger.ts';
import { AgentLaunchError, mergedEnv, preflightLaunch, withLoginShellPath } from './launch.ts';
import { getSharedLoginShellPathProvider } from './login-shell-path.ts';

export type HarnessAvailability = 'present' | 'not-found' | 'unknown';

/**
 * Whether the harness's credential namespace holds a sign-in RECORD. Not
 * whether that record still works.
 *
 * Weak evidence in both directions. Absence proves nothing: Codex supports
 * keyring and ephemeral stores where a signed-in user has no on-disk record at
 * all. Presence proves little more: `codex` deletes `auth.json` only on an
 * explicit user-invoked `codex logout`, so an expired, reused, or revoked
 * refresh token leaves the file sitting there, as does a CLI the user has
 * since uninstalled.
 *
 * The stale-record false positive is accepted knowingly. Parsing the file
 * would not buy much — the dominant lapse is an expired token, which no
 * on-disk check can see — and the two errors are not symmetric: a stale record
 * offers an agent that then asks the user to sign in, while the miss this
 * signal exists to fix hides a working agent entirely.
 *
 * Hence two-valued: the signal may only ever add an agent, never hide one. Do
 * not add an `'absent'` member and start gating on it.
 */
export type HarnessCredentials = 'present' | 'unknown';

interface HarnessSignals {
  readonly availability: HarnessAvailability;
  readonly credentials: HarnessCredentials;
}

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

export type AcpHarnessAvailability = Readonly<Partial<Record<AcpHarnessCli, HarnessSignals>>>;

/**
 * Where each harness keeps the credential namespace its ACP adapter reads.
 *
 * Only Codex is mapped, and the asymmetry is the point. Codex Desktop and the
 * Codex CLI share `$CODEX_HOME/auth.json`, so someone who signed in through
 * Codex Desktop and never installed a `codex` binary has a working runtime
 * (the adapter brings its own) and, in the common case, a usable sign-in — and
 * the PATH probe alone would hide them. Claude Desktop holds an app-owned
 * session that never reaches Claude Code's namespace, so the same inference
 * does not hold there and adding a `~/.claude` entry here would assert
 * something we have no evidence for.
 *
 * Resolution reads `process.env` because `mergedEnv` hands the adapter this
 * same environment; probing a different `CODEX_HOME` than the adapter will use
 * would report on a namespace the agent cannot read.
 */
const HARNESS_CREDENTIAL_PATHS: Readonly<Partial<Record<AcpHarnessCli, () => string>>> = {
  codex: () => join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'),
};

function detectHarnessCredentials(cli: AcpHarnessCli): HarnessCredentials {
  const resolvePath = HARNESS_CREDENTIAL_PATHS[cli];
  if (resolvePath === undefined) return 'unknown';
  let credentialPath: string | undefined;
  try {
    credentialPath = resolvePath();
    return existsSync(credentialPath) ? 'present' : 'unknown';
  } catch (err) {
    // `credentialPath` stays undefined when `resolvePath()` itself threw, so
    // logging it separates "CODEX_HOME pointed somewhere unreadable" from "we
    // never resolved a path at all" (a container with no resolvable home).
    getLogger('acp-harness').warn(
      { cli, credentialPath, err },
      'harness credential probe failed; treating as unknown',
    );
    return 'unknown';
  }
}

/**
 * How long a probe result stays fresh. Sized for the PATH signal, which only
 * changes when someone installs or removes a binary.
 *
 * The credential signal is far more volatile — signing in to Codex Desktop is
 * a moment-to-moment act — and it inherits this TTL underneath a five-minute
 * React Query `staleTime` on `['acp-catalog']`, with no user-facing refresh
 * outside the error state. So someone can sign in, come straight back, and
 * still not be offered the agent for a few minutes. Accepted deliberately:
 * before this signal existed they were never offered it at all, and the row
 * appears on its own shortly after.
 */
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
    /** Test seam: the credential probe is otherwise filesystem-dependent. */
    credentials?: (cli: AcpHarnessCli) => HarnessCredentials;
  } = {},
): () => Promise<AcpHarnessAvailability> {
  const resolveLoginShellPath =
    opts.resolveLoginShellPath ?? getSharedLoginShellPathProvider(getLogger('acp-harness'));
  const preflight = opts.preflight ?? preflightLaunch;
  const probe =
    opts.probe ?? ((cli: AcpHarnessCli) => detectHarness(cli, resolveLoginShellPath, preflight));
  const credentials = opts.credentials ?? detectHarnessCredentials;
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
        // Runs outside the try below because the two signals are independent:
        // a signed-in harness whose preflight blew up is exactly the case this
        // signal exists to rescue.
        //
        // The guard covers the injectable `opts.credentials` seam only —
        // `detectHarnessCredentials` is total, so in production this cannot
        // fire. It stays because the blast radius of a throwing test double is
        // out of proportion to the mistake: it would reject the whole
        // `Promise.all`, and a rejected result is cached for the full TTL
        // rather than evicted, so every catalog request for the next minute
        // fails too.
        let creds: HarnessCredentials = 'unknown';
        try {
          creds = credentials(cli);
        } catch (err) {
          getLogger('acp-harness').warn(
            { cli, err },
            'harness credential probe threw; treating as unknown',
          );
        }
        try {
          return [cli, { availability: await probe(cli), credentials: creds }] as const;
        } catch (err) {
          getLogger('acp-harness').warn(
            { cli, err },
            'harness availability probe rejected; availability unknown',
          );
          return [cli, { availability: 'unknown', credentials: creds }] as const;
        }
      }),
    ).then((entries) => Object.fromEntries(entries) as AcpHarnessAvailability);
    cached = { expiresAt: timestamp + ttlMs, value };
    return value;
  };
}
