import { test } from '@playwright/test';

test(`has a title longer than GitHub keeps ${'and keeps going '.repeat(14)}until the end`, () => {
  throw new Error('the long-titled test fails');
});
