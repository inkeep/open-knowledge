export function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('entries');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function putEntry(database: IDBDatabase, key: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('entries', 'readwrite');
    transaction.objectStore('entries').put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
