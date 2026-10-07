import { afterEach } from 'vitest';

const openConnections = new Set<IDBDatabase>();
const openDatabase = IDBFactory.prototype.open;

IDBFactory.prototype.open = function trackedOpen(
  this: IDBFactory,
  ...args: Parameters<IDBFactory['open']>
): IDBOpenDBRequest {
  const request = openDatabase.apply(this, args);
  request.addEventListener('success', () => {
    openConnections.add(request.result);
  });
  return request;
};

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(new Error(`IndexedDB ${name} could not be deleted`, { cause: request.error }));
    request.onblocked = () =>
      reject(
        new Error(
          `IndexedDB ${name} could not be deleted: a connection outside this test file is still open`,
        ),
      );
  });
}

async function deleteAllDatabases(): Promise<void> {
  for (const connection of openConnections) connection.close();
  openConnections.clear();
  const databases = await indexedDB.databases();
  await Promise.all(
    databases.flatMap(({ name }) => (name === undefined ? [] : [deleteDatabase(name)])),
  );
}

localStorage.clear();
sessionStorage.clear();
await deleteAllDatabases();

afterEach(deleteAllDatabases);
