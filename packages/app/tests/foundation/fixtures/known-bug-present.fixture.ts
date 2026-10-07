import { expect, test } from 'vitest';
import { expectKnownBug } from '../../../../../test-support/known-bug.vitest.test-helper';

const answer = 41;

test('the pinned wrong outcome is still present', async () => {
  await expectKnownBug(/expected 41 to be 42/, () => {
    expect(answer).toBe(42);
  });
});
