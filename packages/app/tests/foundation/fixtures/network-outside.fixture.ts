import { expect, test } from 'vitest';

test('a request to a host outside loopback whose error the test catches', async () => {
  const outcome = await fetch('https://network-guard.example/data.json').then(
    () => 'answered',
    () => 'failed',
  );
  expect(outcome).toBe('failed');
});
