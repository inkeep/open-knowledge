import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import {
  clearPendingSourceNavigation,
  clearPendingSourceNavigationsForTest,
  consumePendingSourceNavigation,
  peekPendingSourceNavigation,
  rememberPendingSourceNavigation,
} from './source-editor-navigation';

afterEach(() => {
  clearPendingSourceNavigationsForTest();
  setSystemTime();
});

describe('source-editor-navigation', () => {
  test('consume returns the pending navigation once for a doc', () => {
    const navigation = {
      kind: 'raw-mdx' as const,
      detail: { offset: 42 },
    };

    rememberPendingSourceNavigation('doc-a', navigation);

    expect(peekPendingSourceNavigation('doc-a')).toEqual(navigation);
    expect(consumePendingSourceNavigation('doc-a')).toEqual(navigation);
    expect(consumePendingSourceNavigation('doc-a')).toBeNull();
  });

  test('pending navigation is doc-scoped and latest-write-wins per doc', () => {
    rememberPendingSourceNavigation('doc-a', {
      kind: 'raw-mdx',
      detail: { offset: 7 },
    });
    rememberPendingSourceNavigation('doc-a', {
      kind: 'outline',
      detail: { index: 3, slug: 'intro', mode: 'source' },
    });
    rememberPendingSourceNavigation('doc-b', {
      kind: 'raw-mdx',
      detail: { offset: 99 },
    });

    expect(consumePendingSourceNavigation('doc-a')).toEqual({
      kind: 'outline',
      detail: { index: 3, slug: 'intro', mode: 'source' },
    });
    expect(consumePendingSourceNavigation('doc-b')).toEqual({
      kind: 'raw-mdx',
      detail: { offset: 99 },
    });
  });

  test('clearPendingSourceNavigation removes entry without returning it', () => {
    rememberPendingSourceNavigation('doc-a', {
      kind: 'raw-mdx',
      detail: { offset: 1 },
    });
    clearPendingSourceNavigation('doc-a');
    expect(consumePendingSourceNavigation('doc-a')).toBeNull();
  });
});

describe('pending-intent expiry', () => {
  const lintNavigation = {
    kind: 'lint' as const,
    detail: { line: 7, column: 2 },
  };

  test('an intent older than 30 seconds is discarded at consume time', () => {
    setSystemTime(new Date('2026-07-09T12:00:00.000Z'));
    rememberPendingSourceNavigation('doc-a', lintNavigation);

    setSystemTime(new Date('2026-07-09T12:00:30.001Z'));
    expect(consumePendingSourceNavigation('doc-a')).toBeNull();
  });

  test('an intent aged exactly 30 seconds is still consumed', () => {
    setSystemTime(new Date('2026-07-09T12:00:00.000Z'));
    rememberPendingSourceNavigation('doc-a', lintNavigation);

    setSystemTime(new Date('2026-07-09T12:00:30.000Z'));
    expect(consumePendingSourceNavigation('doc-a')).toEqual(lintNavigation);
  });

  test('peek reports an expired intent as absent', () => {
    setSystemTime(new Date('2026-07-09T12:00:00.000Z'));
    rememberPendingSourceNavigation('doc-a', lintNavigation);

    setSystemTime(new Date('2026-07-09T12:01:00.000Z'));
    expect(peekPendingSourceNavigation('doc-a')).toBeNull();
  });

  test('re-remembering restarts the expiry clock', () => {
    setSystemTime(new Date('2026-07-09T12:00:00.000Z'));
    rememberPendingSourceNavigation('doc-a', {
      kind: 'raw-mdx',
      detail: { offset: 7 },
    });

    setSystemTime(new Date('2026-07-09T12:00:20.000Z'));
    rememberPendingSourceNavigation('doc-a', lintNavigation);

    // 40s after the first remember, 20s after the second — the refreshed
    // timestamp keeps the intent alive.
    setSystemTime(new Date('2026-07-09T12:00:40.000Z'));
    expect(consumePendingSourceNavigation('doc-a')).toEqual(lintNavigation);
  });
});
