import { describe, expect, test } from 'vitest';
import { type CatalogAgent, detectedHarnessAgents } from './catalog';

function agent(
  id: string,
  availability: 'present' | 'not-found' | 'unknown',
  supported = true,
): CatalogAgent {
  return {
    id,
    name: id,
    version: '1',
    source: 'registry',
    supported,
    featured: true,
    harness: { cli: id === 'cursor' ? 'cursor' : 'claude', availability },
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
});
