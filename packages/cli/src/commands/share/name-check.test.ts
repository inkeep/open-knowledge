/**
 * Unit tests for `checkSharePublishName` — covers the 200/404/401/network
 * decision tree without spawning Octokit or hitting GitHub.
 */

import { describe, expect, test } from 'bun:test';
import type { Octokit } from '@octokit/rest';
import { checkSharePublishName } from './name-check.ts';

function makeFakeOctokit(behavior: { status?: number; message?: string; ok?: boolean }): Octokit {
  return {
    repos: {
      get: async () => {
        if (behavior.ok) return { data: {} };
        throw Object.assign(new Error(behavior.message ?? 'fake'), {
          status: behavior.status,
        });
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: test-only fake; only the touched surface matters.
  } as any;
}

describe('checkSharePublishName', () => {
  test('200 OK → available: false (name taken)', async () => {
    const result = await checkSharePublishName(makeFakeOctokit({ ok: true }), 'alice', 'taken');
    expect(result).toEqual({ kind: 'ok', available: false });
  });

  test('404 → available: true (name free)', async () => {
    const result = await checkSharePublishName(
      makeFakeOctokit({ status: 404, message: 'Not Found' }),
      'alice',
      'free',
    );
    expect(result).toEqual({ kind: 'ok', available: true });
  });

  test('401 → auth-required', async () => {
    const result = await checkSharePublishName(
      makeFakeOctokit({ status: 401, message: 'Bad credentials' }),
      'alice',
      'foo',
    );
    expect(result).toEqual({ kind: 'auth-required' });
  });

  test('500 → network', async () => {
    const result = await checkSharePublishName(
      makeFakeOctokit({ status: 500, message: 'oops' }),
      'alice',
      'foo',
    );
    expect(result).toEqual({ kind: 'network' });
  });

  test('thrown with no status → network', async () => {
    const result = await checkSharePublishName(
      makeFakeOctokit({ message: 'ECONNRESET' }),
      'alice',
      'foo',
    );
    expect(result).toEqual({ kind: 'network' });
  });
});
