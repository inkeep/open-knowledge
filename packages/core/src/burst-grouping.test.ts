/**
 * Unit tests for bucketIntoBursts.
 */
import { describe, expect, test } from 'bun:test';
import { bucketIntoBursts, type SessionTransaction } from './burst-grouping.ts';

function tx(session_id: string, timestamp: number, agent_type?: string): SessionTransaction {
  return { session_id, timestamp, effect: null, agent_type };
}

describe('bucketIntoBursts — no human edits → one burst per session', () => {
  test('single session, multiple transactions → one burst', () => {
    const txs = [tx('agent-a', 100), tx('agent-a', 200), tx('agent-a', 300)];
    const bursts = bucketIntoBursts(txs, []);
    expect(bursts).toHaveLength(1);
    expect(bursts[0].session_id).toBe('agent-a');
    expect(bursts[0].start_ts).toBe(100);
    expect(bursts[0].end_ts).toBe(300);
    expect(bursts[0].transactions).toHaveLength(3);
  });

  test('two sessions, no human edits → two bursts (one per session)', () => {
    const txs = [tx('agent-a', 100), tx('agent-b', 150), tx('agent-a', 200)];
    const bursts = bucketIntoBursts(txs, []);
    const sessionIds = bursts.map((b) => b.session_id).sort();
    expect(bursts).toHaveLength(2);
    expect(sessionIds).toEqual(['agent-a', 'agent-b']);
  });

  test('empty input → empty output', () => {
    expect(bucketIntoBursts([], [])).toEqual([]);
  });
});

describe('bucketIntoBursts — human edit between transactions → new burst boundary', () => {
  test('human edit splits a session into two bursts', () => {
    const txs = [tx('agent-a', 100), tx('agent-a', 300)];
    // Human edit at 200, strictly between 100 and 300
    const bursts = bucketIntoBursts(txs, [{ timestamp: 200 }]);
    expect(bursts).toHaveLength(2);
    expect(bursts[0].start_ts).toBe(100);
    expect(bursts[0].end_ts).toBe(100);
    expect(bursts[1].start_ts).toBe(300);
    expect(bursts[1].end_ts).toBe(300);
  });

  test('human edit at exact transaction timestamp does NOT split (not strictly between)', () => {
    const txs = [tx('agent-a', 100), tx('agent-a', 200)];
    // Human edit exactly at 200 — not "strictly between" 100 and 200
    const bursts = bucketIntoBursts(txs, [{ timestamp: 200 }]);
    expect(bursts).toHaveLength(1);
  });

  test('human edit before all transactions does NOT split', () => {
    const txs = [tx('agent-a', 100), tx('agent-a', 200)];
    const bursts = bucketIntoBursts(txs, [{ timestamp: 50 }]);
    expect(bursts).toHaveLength(1);
  });

  test('two human edits produce three bursts from one session', () => {
    const txs = [tx('s', 100), tx('s', 300), tx('s', 500)];
    const bursts = bucketIntoBursts(txs, [{ timestamp: 200 }, { timestamp: 400 }]);
    expect(bursts).toHaveLength(3);
    expect(bursts.map((b) => b.start_ts)).toEqual([100, 300, 500]);
  });
});

describe('bucketIntoBursts — multi-session interleaved writes', () => {
  test('each session gets independent bursts regardless of other sessions', () => {
    const txs = [tx('agent-a', 100), tx('agent-b', 110), tx('agent-a', 300), tx('agent-b', 310)];
    // Human edit at 200 — splits agent-a but agent-b's consecutive pair is 110→310 which spans 200
    const bursts = bucketIntoBursts(txs, [{ timestamp: 200 }]);
    const abursts = bursts.filter((b) => b.session_id === 'agent-a');
    const bbursts = bursts.filter((b) => b.session_id === 'agent-b');
    // agent-a: 100 and 300 with human edit at 200 → 2 bursts
    expect(abursts).toHaveLength(2);
    // agent-b: 110 and 310 with human edit at 200 → 200 strictly between 110 and 310 → 2 bursts
    expect(bbursts).toHaveLength(2);
  });

  test('three sessions, no human edits → exactly three bursts', () => {
    const txs = [tx('s1', 1), tx('s2', 2), tx('s3', 3), tx('s1', 4)];
    const bursts = bucketIntoBursts(txs, []);
    expect(bursts).toHaveLength(3);
  });
});

describe('bucketIntoBursts — agent_type filter', () => {
  test('filter returns only bursts matching agent_type', () => {
    const txs = [
      tx('agent-a', 100, 'claude'),
      tx('agent-b', 200, 'cursor'),
      tx('agent-a', 300, 'claude'),
    ];
    const bursts = bucketIntoBursts(txs, [], 'claude');
    expect(bursts.every((b) => b.session_id === 'agent-a')).toBe(true);
    expect(bursts.length).toBeGreaterThanOrEqual(1);
  });

  test('filter with no matching agent_type → empty array', () => {
    const txs = [tx('agent-a', 100, 'cursor')];
    const bursts = bucketIntoBursts(txs, [], 'claude');
    expect(bursts).toEqual([]);
  });

  test('undefined filter → all bursts returned', () => {
    const txs = [tx('agent-a', 100, 'claude'), tx('agent-b', 200, 'cursor')];
    const bursts = bucketIntoBursts(txs, []);
    expect(bursts).toHaveLength(2);
  });
});
