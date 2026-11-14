import { test } from '@playwright/test';

test('fails its first try, then passes', () => {
  if (test.info().retry === 0) throw new Error('the first try fails');
});
