import { expect, test } from '@playwright/test';

test('fails two soft assertions in one try', () => {
  expect.soft(1, 'the first soft assertion').toBe(2);
  expect.soft(2, 'the second soft assertion').toBe(3);
});
