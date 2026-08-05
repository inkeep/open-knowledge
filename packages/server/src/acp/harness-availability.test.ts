import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  ACP_AGENT_HARNESS_CLIS,
  type AcpHarnessCli,
  createAcpHarnessAvailabilityProbe,
  type HarnessAvailability,
} from './harness-availability.ts';

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
