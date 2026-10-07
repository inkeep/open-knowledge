import { expect, test } from 'vitest';

Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });

test('a test whose module defines window when it loads', () => {
  expect(typeof process.versions.node).toBe('string');
});
