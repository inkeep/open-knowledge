import { watch } from 'node:fs';
import { expect, test } from 'vitest';

test('a file importing a node:fs export the browser tier does not provide never runs', () => {
  expect(watch).toBeUndefined();
});
