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
      now: () => timestamp,
      ttlMs: 50,
    });

    const first = probe();
    expect(probe()).toBe(first);
    expect(await first).toEqual(availability);
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
    });
    expect(await probe()).toEqual({
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
    });
    const result = await probe();
    // Whatever this machine happens to have installed, every CLI that missed
    // the base PATH must have been given the login-shell second chance.
    const missing = Object.values(result).filter((v) => v === 'not-found').length;
    expect(consulted).toBe(missing);
  });

  test('contains a rejected per-harness probe as unknown', async () => {
    const probe = createAcpHarnessAvailabilityProbe({
      probe: async (cli) => {
        if (cli === 'codex') throw new Error('probe failed');
        return 'not-found';
      },
    });

    expect((await probe()).codex).toBe('unknown');
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
    });
    const result = await probe();
    for (const [cli, verdict] of Object.entries(result)) {
      expect({ cli, verdict }).toEqual({ cli, verdict: 'unknown' });
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
    });
    const result = await probe();
    for (const verdict of Object.values(result)) expect(verdict).toBe('unknown');
    const records = [...acpLog.warn.mock.calls, ...acpLog.info.mock.calls];
    expect(records.length).toBeGreaterThan(0);
    expect(
      records.some((call) =>
        call.some((arg) => (arg as { err?: unknown })?.err === captureFailure),
      ),
    ).toBe(true);
  });
});
