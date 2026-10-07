import { afterAll, expect, test } from 'vitest';
import { openDatabase, putEntry } from './idb-fixture.test-helper';

test('a file writes web storage and leaves an IndexedDB connection open', async () => {
  localStorage.setItem('poison', 'local');
  sessionStorage.setItem('poison', 'session');
  const database = await openDatabase('poison-in-test');
  await putEntry(database, 'poison', 'indexeddb');

  expect([localStorage.getItem('poison'), sessionStorage.getItem('poison')]).toEqual([
    'local',
    'session',
  ]);
  expect((await indexedDB.databases()).map(({ name }) => name)).toEqual(['poison-in-test']);
});

afterAll(async () => {
  localStorage.setItem('poison-after-all', 'local');
  sessionStorage.setItem('poison-after-all', 'session');
  const database = await openDatabase('poison-after-all');
  await putEntry(database, 'poison', 'indexeddb');
  database.close();
});
