import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { getCollector } from '../lib/perf/collector';
import {
  __peekPrewarmRecord,
  __resetPrewarmCorrelation,
  consumePrewarmClick,
  recordPrewarm,
} from './prewarm-correlation';

describe('prewarm-correlation', () => {
  beforeEach(() => {
    getCollector()?.reset();
    __resetPrewarmCorrelation();
  });

  afterEach(() => {
    __resetPrewarmCorrelation();
  });

  test('recordPrewarm stores docName + poolEventId + timestamp', () => {
    recordPrewarm('doc-a', 'event-a', 1_000);
    const got = __peekPrewarmRecord('doc-a');
    expect(got).toEqual({ poolEventId: 'event-a', emittedAt: 1_000 });
  });

  test('consumePrewarmClick matches by poolEventId equality and emits clicked + counter', () => {
    recordPrewarm('doc-a', 'event-a', 1_000);
    const matched = consumePrewarmClick('doc-a', 'event-a', 1_500);
    expect(matched).toBe(true);
    expect(__peekPrewarmRecord('doc-a')).toBeUndefined();
    const c = getCollector();
    expect(c?.counters['ok/sidebar/prewarm']?.byProp.hit?.true).toBe(1);
    const clickedMark = c?.marks.toArray().find((m) => m.name === 'ok/sidebar/prewarm-clicked');
    expect(clickedMark?.properties).toEqual({
      docName: 'doc-a',
      t: 1_500,
      poolEventId: 'event-a',
    });
  });

  test('consumePrewarmClick rejects when poolEventId differs (deterministic join)', () => {
    recordPrewarm('doc-a', 'event-a', 1_000);
    const matched = consumePrewarmClick('doc-a', 'event-DIFFERENT', 1_500);
    expect(matched).toBe(false);
    expect(__peekPrewarmRecord('doc-a')).toEqual({ poolEventId: 'event-a', emittedAt: 1_000 });
    const c = getCollector();
    expect(c?.counters['ok/sidebar/prewarm']?.byProp.hit?.true).toBeUndefined();
  });

  test('consumePrewarmClick rejects when TTL expired (>= 5000 ms by default)', () => {
    recordPrewarm('doc-a', 'event-a', 1_000);
    const matched = consumePrewarmClick('doc-a', 'event-a', 1_000 + 5_000);
    expect(matched).toBe(false);
  });

  test('consumePrewarmClick rejects when no record for docName', () => {
    const matched = consumePrewarmClick('doc-other', 'event-a', 100);
    expect(matched).toBe(false);
  });

  test('a later prewarm overwrites the earlier record (latest wins)', () => {
    recordPrewarm('doc-a', 'event-1', 1_000);
    recordPrewarm('doc-a', 'event-2', 1_500);
    expect(__peekPrewarmRecord('doc-a')).toEqual({
      poolEventId: 'event-2',
      emittedAt: 1_500,
    });
    expect(consumePrewarmClick('doc-a', 'event-1', 1_600)).toBe(false);
    expect(consumePrewarmClick('doc-a', 'event-2', 1_600)).toBe(true);
  });

  test('recordPrewarm emits hit:false when overwriting a prior record', () => {
    recordPrewarm('doc-a', 'event-1', 1_000);
    expect(getCollector()?.counters['ok/sidebar/prewarm']?.byProp.hit?.false).toBeUndefined();

    recordPrewarm('doc-a', 'event-2', 1_500);
    expect(getCollector()?.counters['ok/sidebar/prewarm']?.byProp.hit?.false).toBe(1);

    recordPrewarm('doc-a', 'event-3', 2_000);
    expect(getCollector()?.counters['ok/sidebar/prewarm']?.byProp.hit?.false).toBe(2);
  });

  test('recordPrewarm does not emit hit:false on the first record for a docName', () => {
    recordPrewarm('doc-a', 'event-1', 1_000);
    recordPrewarm('doc-b', 'event-2', 1_500);
    expect(getCollector()?.counters['ok/sidebar/prewarm']?.byProp.hit?.false).toBeUndefined();
  });
});
