import { test } from 'vitest';
import { expectKnownBug } from '../../../../../test-support/known-bug.vitest.test-helper';

function readAnswer(): number {
  throw new TypeError('the subject could not be read');
}

test('a different error is thrown inside the pinned assertion', async () => {
  await expectKnownBug(/expected 41 to be 42/, () => readAnswer());
});
