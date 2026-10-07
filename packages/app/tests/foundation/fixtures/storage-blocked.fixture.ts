import { expect, test } from 'vitest';

const HOLD_CONNECTION_OPEN = `
  const request = indexedDB.open('held-by-worker', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('entries');
  request.onsuccess = () => postMessage('opened');
`;

test('a database a worker keeps open cannot be deleted after the test', async () => {
  const source = URL.createObjectURL(new Blob([HOLD_CONNECTION_OPEN], { type: 'text/javascript' }));
  const worker = new Worker(source);
  const opened = await new Promise((resolve) => {
    worker.onmessage = (event) => resolve(event.data);
  });

  expect(opened).toBe('opened');
});
