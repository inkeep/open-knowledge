import { expect, test } from 'vitest';

test('a test that needs no DOM', () => {
  expect(typeof process.versions.node).toBe('string');
});
