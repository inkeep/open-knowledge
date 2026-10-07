import { expect, test } from 'vitest';

test('a test that defines localStorage while it runs', () => {
  Object.defineProperty(globalThis, 'localStorage', { value: {}, configurable: true });
  expect(typeof process.versions.node).toBe('string');
});
