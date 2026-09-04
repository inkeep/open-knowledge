import 'fake-indexeddb/auto';
import { afterEach } from 'vitest';

afterEach(async () => {
  if (typeof indexedDB === 'undefined') return;
  const dbs = await indexedDB.databases();
  await Promise.all(
    dbs.map((info) => {
      if (info.name === undefined) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(info.name as string);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      });
    }),
  );
});
