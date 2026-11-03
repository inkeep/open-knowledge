import { test } from '@playwright/test';
import { expectTheImpossible } from './failing-helper.ts';

test('fails inside a helper', () => {
  expectTheImpossible();
});
