import { expect, test } from 'vitest';

test('a file starts with empty web storage and no IndexedDB databases', async () => {
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  expect(await indexedDB.databases()).toEqual([]);
});
