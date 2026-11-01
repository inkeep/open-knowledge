import { createKeychainEmbeddingsStore } from './keychain-embeddings-store.ts';

const path = process.argv[2];
if (!path) throw new Error('Missing secrets path');
const blocked = Promise.withResolvers<void>();
process.stdin.on('data', () => blocked.resolve());
process.stdin.resume();
const store = createKeychainEmbeddingsStore(path, {
  get: async () => null,
  set: async () => {
    process.stdout.write('READY\n');
    await blocked.promise;
  },
  clear: async () => {},
});
await store.setForProject('/crash', 'https://api.openai.com/v1', 'crash-test-key');
