import { expect, test } from 'vitest';
import { expectKnownBug } from '../../../../../test-support/known-bug.vitest.test-helper';

const answer = 42;

test('the pinned wrong outcome no longer occurs', async () => {
  await expectKnownBug(/expected 41 to be 42/, () => {
    expect(answer).toBe(42);
  });
});
