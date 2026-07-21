import { describe, expect, test } from 'vitest';
import {
  AGENT_THREAD_SENTINEL_DOC,
  CONNECTED_SENTINEL_DOC,
  isPresenceSentinelDocName,
} from './awareness.ts';

describe('isPresenceSentinelDocName', () => {
  test('matches the presence sentinels', () => {
    expect(isPresenceSentinelDocName(CONNECTED_SENTINEL_DOC)).toBe(true);
    expect(isPresenceSentinelDocName(AGENT_THREAD_SENTINEL_DOC)).toBe(true);
  });

  test('null / undefined are not sentinels', () => {
    expect(isPresenceSentinelDocName(null)).toBe(false);
    expect(isPresenceSentinelDocName(undefined)).toBe(false);
  });

  test('exact match only — real parenthesised docNames are not sentinels', () => {
    // A leading-`(` heuristic would over-match these legitimate filenames.
    expect(isPresenceSentinelDocName('(WIP) draft')).toBe(false);
    expect(isPresenceSentinelDocName('(2026-05-13) standup')).toBe(false);
    expect(isPresenceSentinelDocName('articles/tea/terroir')).toBe(false);
  });
});
