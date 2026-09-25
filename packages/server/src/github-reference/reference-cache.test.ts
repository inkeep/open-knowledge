import { describe, expect, test } from 'vitest';
import type { GitHubReferenceOutcome } from './fetch-reference.ts';
import { GitHubReferenceCache } from './reference-cache.ts';

const preview = (lifecycle: 'open' | 'merged'): GitHubReferenceOutcome => ({
  ok: true,
  preview: {
    kind: 'pull',
    repo: 'inkeep/agents',
    number: 1,
    title: 't',
    author: null,
    createdAt: '2026-09-20T10:00:00Z',
    lifecycle,
  },
});

describe('GitHubReferenceCache', () => {
  test('concurrent loads share one fetch', async () => {
    const cache = new GitHubReferenceCache();
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return preview('open');
    };
    await Promise.all([cache.load('k', compute), cache.load('k', compute)]);
    expect(calls).toBe(1);
  });

  test('open items refresh after a minute while settled ones are kept longer', async () => {
    let now = 0;
    const cache = new GitHubReferenceCache(() => now);
    let calls = 0;
    const load = (key: string, lifecycle: 'open' | 'merged') =>
      cache.load(key, async () => {
        calls += 1;
        return preview(lifecycle);
      });
    await load('open', 'open');
    await load('merged', 'merged');
    now = 61_000;
    await load('open', 'open');
    await load('merged', 'merged');
    expect(calls).toBe(3);
  });

  test('a not-found answer is remembered, an outage only briefly', async () => {
    let now = 0;
    const cache = new GitHubReferenceCache(() => now);
    let calls = 0;
    const load = (key: string, reason: 'not-found' | 'unavailable') =>
      cache.load(key, async () => {
        calls += 1;
        return { ok: false, reason };
      });
    await load('missing', 'not-found');
    await load('down', 'unavailable');
    now = 120_000;
    await load('missing', 'not-found');
    await load('down', 'unavailable');
    expect(calls).toBe(3);
  });
});
