import { expect, test } from 'vitest';
import { refusalKey } from './bug-lane-refusal-key.mjs';

const refusal = {
  verdict: 'fail',
  stable: 'v0.77.8',
  fixRefs: 'a',
  survivingRefs: 'a',
  failures: ['src/acp/launch.test.ts > missing uvx'],
  day: '2026-09-24',
};

test('another batch blocked in the same failing suites stays in the same daily incident', () => {
  expect(
    refusalKey({
      ...refusal,
      fixRefs: 'a,b',
      survivingRefs: 'b',
      failures: ['src/acp/launch.test.ts > another case', ...refusal.failures],
    }),
  ).toBe(refusalKey(refusal));
});

test.each([
  { stable: 'v0.77.9' },
  { day: '2026-09-25' },
  { failures: ['src/different.test.ts > failed'] },
  { verdict: 'could-not-verify' },
])('a changed base, suite, day or verdict re-arms the notification: %j', (change) => {
  expect(refusalKey({ ...refusal, ...change })).not.toBe(refusalKey(refusal));
});

test('unknown failures and conflicts retain per-batch identity', () => {
  for (const verdict of ['conflict', 'could-not-verify', 'fail']) {
    const input = { ...refusal, verdict, failures: [] };
    expect(refusalKey({ ...input, fixRefs: 'different' })).not.toBe(refusalKey(input));
  }
});
