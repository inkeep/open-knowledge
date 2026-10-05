import { expect, test } from '@playwright/test';

test('nested lifetime control reaches its test body', async () => {
  expect(process.env.OK_PORT_OWNERSHIP_RUN_DIR).toBeTruthy();
});
