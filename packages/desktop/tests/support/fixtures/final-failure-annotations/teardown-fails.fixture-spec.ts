import { test as base } from '@playwright/test';

const test = base.extend<object, { brokenTeardown: undefined }>({
  brokenTeardown: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture contract
    async ({}, use) => {
      await use(undefined);
      throw new Error('worker teardown failed on purpose');
    },
    { scope: 'worker', auto: true },
  ],
});

test('passes before its worker fails to tear down', () => {});
