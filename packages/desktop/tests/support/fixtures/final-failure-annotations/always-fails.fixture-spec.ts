import { test } from '@playwright/test';

test.describe('a suite, with a comma', () => {
  test('fails on every try :: and says which', () => {
    throw new Error(`try ${test.info().retry} failed`);
  });
});
