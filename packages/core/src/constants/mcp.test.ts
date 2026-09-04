import { describe, expect, test } from 'vitest';
import { OK_DESKTOP_TERMINAL_ENV, OK_HOSTED_AGENT_ENV, resolveIsHostedAgent } from './mcp.ts';

describe('resolveIsHostedAgent', () => {
  test('either marker alone is enough — the two surfaces are disjoint by construction', () => {
    expect(resolveIsHostedAgent({ [OK_DESKTOP_TERMINAL_ENV]: '1' })).toBe(true);
    expect(resolveIsHostedAgent({ [OK_HOSTED_AGENT_ENV]: '1' })).toBe(true);
  });

  test('both set (belt-and-braces paths overlapping) still resolves hosted', () => {
    expect(
      resolveIsHostedAgent({
        [OK_DESKTOP_TERMINAL_ENV]: '1',
        [OK_HOSTED_AGENT_ENV]: '1',
      }),
    ).toBe(true);
  });

  test('an env with neither marker is not hosted — external agents keep their URL', () => {
    expect(resolveIsHostedAgent({})).toBe(false);
    expect(resolveIsHostedAgent({ PATH: '/usr/bin', HOME: '/home/x' })).toBe(false);
  });

  test('only the exact value "1" counts', () => {
    for (const value of ['0', '', 'true', 'yes', 'false']) {
      expect(resolveIsHostedAgent({ [OK_HOSTED_AGENT_ENV]: value })).toBe(false);
      expect(resolveIsHostedAgent({ [OK_DESKTOP_TERMINAL_ENV]: value })).toBe(false);
    }
  });

  test('undefined values (the shape process.env hands us) are not hosted', () => {
    expect(
      resolveIsHostedAgent({
        [OK_HOSTED_AGENT_ENV]: undefined,
        [OK_DESKTOP_TERMINAL_ENV]: undefined,
      }),
    ).toBe(false);
  });
});
