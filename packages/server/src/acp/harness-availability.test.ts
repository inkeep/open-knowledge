import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import {
  ACP_AGENT_HARNESS_CLIS,
  createAcpHarnessAvailabilityProbe,
  type HarnessAvailability,
} from './harness-availability.ts';

describe('ACP harness availability', () => {
  test('maps the registry-backed harness agents to their real CLI ids', () => {
    expect(ACP_AGENT_HARNESS_CLIS).toEqual({
      'claude-acp': 'claude',
      'codex-acp': 'codex',
      cursor: 'cursor',
      opencode: 'opencode',
    });
  });

  test('probes every mapped harness once and caches the in-flight result', async () => {
    const calls: TerminalCli[] = [];
    let timestamp = 100;
    const availability: Partial<Record<TerminalCli, HarnessAvailability>> = {
      claude: 'present',
      codex: 'not-found',
      cursor: 'unknown',
      opencode: 'present',
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
    expect(calls).toEqual(['claude', 'codex', 'cursor', 'opencode']);

    timestamp = 151;
    await probe();
    expect(calls).toHaveLength(8);
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
