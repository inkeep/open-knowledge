import { expect, test } from 'vitest';

test('a test whose work never settles', async () => {
  await new Promise<never>(() => {});
  expect.unreachable();
});
