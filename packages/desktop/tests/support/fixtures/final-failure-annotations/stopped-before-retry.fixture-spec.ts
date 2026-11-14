import { test } from '@playwright/test';

test('fails its first try, then the run stops before its retry', () => {
  throw new Error('the first try fails');
});

test.describe('a test with no retries', () => {
  test.describe.configure({ retries: 0 });

  test('fails its only try and reaches the failure limit', () => {
    throw new Error('the failure limit is reached');
  });
});
