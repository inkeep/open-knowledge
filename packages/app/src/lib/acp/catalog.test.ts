import { describe, expect, test } from 'vitest';
import { type CatalogAgent, detectedHarnessAgents, harnessPresenceRank } from './catalog';

type HarnessCli = NonNullable<CatalogAgent['harness']>['cli'];

/** Mirrors the server's agent-id → CLI mapping so fixtures name a real pair. */
const HARNESS_CLI: Record<string, HarnessCli> = {
  'claude-acp': 'claude',
  'codex-acp': 'codex',
  cursor: 'cursor',
  opencode: 'opencode',
};

function agent(
  id: string,
  availability: 'present' | 'not-found' | 'unknown',
  supported = true,
  credentials: 'present' | 'unknown' = 'unknown',
): CatalogAgent {
  return {
    id,
    name: id,
    version: '1',
    source: 'registry',
    supported,
    featured: true,
    harness: { cli: HARNESS_CLI[id] ?? 'claude', availability, credentials },
  };
}

describe('detectedHarnessAgents', () => {
  test('returns supported, present harnesses in default priority order', () => {
    expect(
      detectedHarnessAgents([
        agent('cursor', 'present'),
        agent('claude-acp', 'present'),
        agent('codex-acp', 'not-found'),
        agent('opencode', 'present', false),
      ]).map((entry) => entry.id),
    ).toEqual(['claude-acp', 'cursor']);
  });

  test('existing credentials detect an agent whose CLI is not on PATH', () => {
    // The Codex Desktop case: the adapter brings its own runtime and the login
    // is already in the shared store, so a missing `codex` binary must not hide
    // an agent that would start and authenticate on the first try.
    expect(
      detectedHarnessAgents([agent('codex-acp', 'not-found', true, 'present')]).map((e) => e.id),
    ).toEqual(['codex-acp']);
  });

  test('credentials do not rescue an agent with no launchable distribution', () => {
    expect(detectedHarnessAgents([agent('codex-acp', 'not-found', false, 'present')])).toEqual([]);
  });
});

describe('harnessPresenceRank', () => {
  test('credentials keep a PATH-absent agent out of the sunk tier', () => {
    expect(harnessPresenceRank(agent('codex-acp', 'not-found', true, 'present'))).toBe(0);
    expect(harnessPresenceRank(agent('codex-acp', 'not-found'))).toBe(1);
  });

  test('a pending probe still ranks with present', () => {
    expect(harnessPresenceRank(agent('claude-acp', 'unknown'))).toBe(0);
  });
});
