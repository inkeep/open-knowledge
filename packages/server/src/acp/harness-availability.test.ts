import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  ACP_AGENT_HARNESS_CLIS,
  type AcpHarnessCli,
  createAcpHarnessAvailabilityProbe,
  type HarnessAvailability,
} from './harness-availability.ts';
import { AgentLaunchError } from './launch.ts';

/** Spy logger shared by every `getLogger(name)` call inside the availability
 *  module — the observation seam for the verdict-observability contract (a
 *  degraded verdict must leave an operator-visible trace). */
const acpLog = vi.hoisted(() => {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  };
  return logger;
});
vi.mock('../logger.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../logger.ts')>()),
  getLogger: () => acpLog,
}));

let shims: string[] = [];
afterEach(() => {
  for (const d of shims) rmSync(d, { recursive: true, force: true });
  shims = [];
});

/**
 * The real credential probe reads the host filesystem, so every availability
 * assertion below pins it — otherwise a dev machine with `~/.codex/auth.json`
 * and CI disagree about the same expected object.
 */
const noCredentials = () => 'unknown' as const;

/** Availability-only view, for the assertions that predate the second signal. */
function availabilityOf(
  result: Awaited<ReturnType<ReturnType<typeof createAcpHarnessAvailabilityProbe>>>,
): Record<string, HarnessAvailability> {
  return Object.fromEntries(
    Object.entries(result).map(([cli, signals]) => [cli, signals.availability]),
  );
}

describe('ACP harness availability', () => {
  test('maps the registry-backed harness agents to their real CLI ids', () => {
    expect(ACP_AGENT_HARNESS_CLIS).toEqual({
      'claude-acp': 'claude',
      'codex-acp': 'codex',
      cursor: 'cursor',
      gemini: 'gemini',
      opencode: 'opencode',
      'pi-acp': 'pi',
    });
  });

  test('probes every mapped harness once and caches the in-flight result', async () => {
    const calls: AcpHarnessCli[] = [];
    let timestamp = 100;
    const availability: Partial<Record<AcpHarnessCli, HarnessAvailability>> = {
      claude: 'present',
      codex: 'not-found',
      cursor: 'unknown',
      gemini: 'present',
      opencode: 'present',
      pi: 'not-found',
    };
    const probe = createAcpHarnessAvailabilityProbe({
      probe: async (cli) => {
        calls.push(cli);
        return availability[cli] ?? 'unknown';
      },
      credentials: noCredentials,
      now: () => timestamp,
      ttlMs: 50,
    });

    const first = probe();
    expect(probe()).toBe(first);
    expect(availabilityOf(await first)).toEqual(availability);
    expect(calls).toEqual(['claude', 'codex', 'cursor', 'gemini', 'opencode', 'pi']);

    timestamp = 151;
    await probe();
    expect(calls).toHaveLength(12);
  });

  // Availability drives defaulting, so it has to agree with what the launch
  // chain can actually start. On a machine where the harness lives only on the
  // login shell's PATH (nvm/fnm), reporting `not-found` would steer the user
  // away from an agent that works. On CI none of these CLIs are installed, so
  // every entry here exercises the fallback.
  test('a harness reachable only via the login shell reports present', async () => {
    const shimDir = mkdtempSync(join(tmpdir(), 'harness-avail-test-'));
    shims.push(shimDir);
    for (const bin of ['claude', 'codex', 'cursor-agent', 'gemini', 'opencode', 'pi']) {
      writeFileSync(join(shimDir, bin), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const probe = createAcpHarnessAvailabilityProbe({
      resolveLoginShellPath: async () => shimDir,
      credentials: noCredentials,
    });
    expect(availabilityOf(await probe())).toEqual({
      claude: 'present',
      codex: 'present',
      cursor: 'present',
      gemini: 'present',
      opencode: 'present',
      pi: 'present',
    });
  });

  test('a harness missing from the login shell too stays not-found', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'harness-avail-test-'));
    shims.push(emptyDir);
    let consulted = 0;
    const probe = createAcpHarnessAvailabilityProbe({
      resolveLoginShellPath: async () => {
        consulted += 1;
        return emptyDir;
      },
      credentials: noCredentials,
    });
    const result = await probe();
    // Whatever this machine happens to have installed, every CLI that missed
    // the base PATH must have been given the login-shell second chance.
    const missing = Object.values(result).filter((v) => v.availability === 'not-found').length;
    expect(consulted).toBe(missing);
  });

  test('contains a rejected per-harness probe as unknown', async () => {
    const probe = createAcpHarnessAvailabilityProbe({
      probe: async (cli) => {
        if (cli === 'codex') throw new Error('probe failed');
        return 'not-found';
      },
      credentials: noCredentials,
    });

    expect((await probe()).codex?.availability).toBe('unknown');
  });
});

describe('harness credentials (a second positive signal, never a negative one)', () => {
  test('an existing sign-in is reported even when the PATH probe rejects', async () => {
    // The two signals are independent: a signed-in harness whose preflight blew
    // up is exactly the case the credential probe exists to rescue, so a
    // rejected availability probe must not also swallow the credential answer.
    const probe = createAcpHarnessAvailabilityProbe({
      probe: async () => {
        throw new Error('probe failed');
      },
      credentials: (cli) => (cli === 'codex' ? 'present' : 'unknown'),
    });

    expect((await probe()).codex).toEqual({ availability: 'unknown', credentials: 'present' });
  });

  test('a throwing credential probe degrades that harness without poisoning the cache', async () => {
    // The result promise is cached for the whole TTL and rejections are never
    // evicted, so an unguarded throw here would answer every catalog request
    // for the next minute with a 502 instead of a degraded row.
    const probe = createAcpHarnessAvailabilityProbe({
      probe: async () => 'not-found',
      credentials: (cli) => {
        if (cli === 'codex') throw new Error('credential probe exploded');
        return 'unknown';
      },
    });

    await expect(probe()).resolves.toMatchObject({
      codex: { availability: 'not-found', credentials: 'unknown' },
    });
  });

  test('reads the Codex sign-in from the CODEX_HOME the adapter would inherit', async () => {
    // Pins the shared-store contract the Codex Desktop case rests on: Desktop
    // and CLI both land on `$CODEX_HOME/auth.json`, and the probe has to read
    // the same env the launch chain passes through `mergedEnv`.
    const codexHome = mkdtempSync(join(tmpdir(), 'harness-creds-test-'));
    shims.push(codexHome);
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const before = await createAcpHarnessAvailabilityProbe({ probe: async () => 'not-found' })();
      expect(before.codex?.credentials).toBe('unknown');

      writeFileSync(join(codexHome, 'auth.json'), '{}');
      const after = await createAcpHarnessAvailabilityProbe({ probe: async () => 'not-found' })();
      expect(after.codex?.credentials).toBe('present');
      // Only Codex is mapped — Claude Desktop keeps an app-owned session that
      // never reaches Claude Code's namespace, so no `~/.claude` inference.
      expect(after.claude?.credentials).toBe('unknown');
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });
});

describe('unverified verdicts (a probe failure is not absence, and must leave a trace)', () => {
  // Hermetic via the injected preflight seam: every first chance misses
  // deterministically regardless of what is installed on the host, so the
  // capture-failure branch is exercised on dev machines and CI alike.
  const firstChanceAlwaysMisses = async () => {
    throw new AgentLaunchError('command-not-found', 'injected: first chance misses');
  };
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('a failed login-shell PATH capture reports unknown, never not-found', async () => {
    // The second-chance login-shell PATH could not be captured, so absence was
    // never verified for any CLI that missed the base PATH. Reporting the
    // positive `not-found` off a capture failure is the same conflation the
    // probe layer forbids: capture failure ≠ absence.
    const probe = createAcpHarnessAvailabilityProbe({
      preflight: firstChanceAlwaysMisses,
      resolveLoginShellPath: async () => null,
      credentials: noCredentials,
    });
    const result = await probe();
    for (const [cli, signals] of Object.entries(result)) {
      expect({ cli, verdict: signals.availability }).toEqual({ cli, verdict: 'unknown' });
    }
    // Guard against a vacuous pass: every mapped harness got a verdict.
    expect(Object.keys(result)).toHaveLength(6);
  });

  test('a degraded (unverified) verdict leaves an operator-visible log trace naming the cause', async () => {
    // A defaulting signal that silently degrades makes a field report
    // undiagnosable — the capture-failure path must log at info or warn, and
    // must carry the capture failure's cause when the provider rejected.
    const captureFailure = new Error('login shell exited before printing PATH');
    const probe = createAcpHarnessAvailabilityProbe({
      preflight: firstChanceAlwaysMisses,
      resolveLoginShellPath: async () => {
        throw captureFailure;
      },
      credentials: noCredentials,
    });
    const result = await probe();
    for (const signals of Object.values(result)) expect(signals.availability).toBe('unknown');
    const records = [...acpLog.warn.mock.calls, ...acpLog.info.mock.calls];
    expect(records.length).toBeGreaterThan(0);
    expect(
      records.some((call) =>
        call.some((arg) => (arg as { err?: unknown })?.err === captureFailure),
      ),
    ).toBe(true);
  });
});
