import { expect, test } from 'vitest';
import { expectKnownBug } from '../../../../../test-support/known-bug.vitest.test-helper';

function prepareAnswer(): number {
  throw new RangeError('the fixture setup failed');
}

test('an error is thrown before the pinned assertion runs', async () => {
  const answer = prepareAnswer();
  await expectKnownBug(/expected 41 to be 42/, () => {
    expect(answer).toBe(42);
  });
});
