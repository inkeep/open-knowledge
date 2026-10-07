import { test } from 'vitest';
import { expectKnownBug } from '../../../../../test-support/known-bug.vitest.test-helper';

const ESC = String.fromCharCode(27);

test('the wrong outcome is reported with ANSI colour codes', async () => {
  await expectKnownBug(/expected 41 to be 42/, () => {
    throw new Error(`${ESC}[31mexpected${ESC}[39m 41 to be 42`);
  });
});
