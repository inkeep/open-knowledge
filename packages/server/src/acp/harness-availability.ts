import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { getLogger } from '../logger.ts';
import { AgentLaunchError, mergedEnv, preflightLaunch, withLoginShellPath } from './launch.ts';
import { getSharedLoginShellPathProvider } from './login-shell-path.ts';

export type HarnessAvailability = 'present' | 'not-found' | 'unknown';

export type HarnessCredentials = 'present' | 'unknown';

interface HarnessSignals {
  readonly availability: HarnessAvailability;
  readonly credentials: HarnessCredentials;
}

export type AcpHarnessCli = TerminalCli | 'gemini';

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
    getLogger('acp-harness').warn(
      { cli, credentialPath, err },
      'harness credential probe failed; treating as unknown',
    );
    return 'unknown';
  }
}

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
      getLogger('acp-harness').warn(
        { cli, err },
        'harness preflight failed before absence could be verified; availability unknown',
      );
      return 'unknown';
    }
    let loginShellPath: string | null = null;
    let captureErr: unknown;
    try {
      loginShellPath = await resolveLoginShellPath();
    } catch (resolveErr) {
      captureErr = resolveErr;
    }
    if (loginShellPath === null) {
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
    resolveLoginShellPath?: () => Promise<string | null>;
    preflight?: typeof preflightLaunch;
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
