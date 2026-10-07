import { expect, test } from 'vitest';

test('the browser graph reads CI as set, with no Node process global', () => {
  expect('process' in globalThis).toBe(false);
  expect(process.env.CI ? 'set' : 'unset').toBe('set');
});

test('the browser graph reads CI as unset, with no Node process global', () => {
  expect('process' in globalThis).toBe(false);
  expect(process.env.CI ? 'set' : 'unset').toBe('unset');
});
