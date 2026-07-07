import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  clearEmbeddingsKeyFromAllBackends,
  describeStoredEmbeddingsKey,
  FileEmbeddingsBackend,
  makeLazyEmbeddingsKeyStore,
} from './secrets-store.ts';

const KEY = 'sk-secret-embeddings-key-1234567890';

let dir: string;
let secretsFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ok-embkey-'));
  secretsFile = join(dir, '.ok', 'secrets.yml');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('FileEmbeddingsBackend', () => {
  test('set → get round-trips the key', async () => {
    const store = new FileEmbeddingsBackend(secretsFile);
    expect(await store.get()).toBeNull();
    await store.set(KEY);
    expect(await store.get()).toBe(KEY);
  });

  test('writes the secrets file with 0600 permissions', async () => {
    const store = new FileEmbeddingsBackend(secretsFile);
    await store.set(KEY);
    expect(existsSync(secretsFile)).toBe(true);
    const mode = statSync(secretsFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('re-asserts 0600 on a pre-existing, looser-permissioned secrets file', async () => {
    // Simulate a secrets file created world-readable by an older build / external
    // tool. `writeFileSync`'s mode only applies at creation, so the rewrite must
    // chmod it back to 0600.
    mkdirSync(join(dir, '.ok'), { recursive: true });
    writeFileSync(secretsFile, 'other: keep-me\n');
    chmodSync(secretsFile, 0o644);
    await new FileEmbeddingsBackend(secretsFile).set(KEY);
    expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
  });

  test('get() self-heals a world-readable file to 0600 on the read path (no write needed)', async () => {
    // The key is read on every search but rewritten rarely, so a file left
    // group/other-readable (older build / external tool / hand-edit) must be
    // tightened on READ — otherwise it could stay world-readable indefinitely.
    mkdirSync(join(dir, '.ok'), { recursive: true });
    writeFileSync(secretsFile, `OPENAI_API_KEY: ${KEY}\n`);
    chmodSync(secretsFile, 0o644);
    const store = new FileEmbeddingsBackend(secretsFile);
    expect(await store.get()).toBe(KEY); // read still returns the key...
    expect(statSync(secretsFile).mode & 0o777).toBe(0o600); // ...and tightened it
  });

  test('get() leaves an already-0600 file untouched', async () => {
    await new FileEmbeddingsBackend(secretsFile).set(KEY); // written 0600
    expect(await new FileEmbeddingsBackend(secretsFile).get()).toBe(KEY);
    expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
  });

  test('clear removes the key; get returns null again', async () => {
    const store = new FileEmbeddingsBackend(secretsFile);
    await store.set(KEY);
    await store.clear();
    expect(await store.get()).toBeNull();
  });

  test('clear unlinks the file when the key was the only secret', async () => {
    const store = new FileEmbeddingsBackend(secretsFile);
    await store.set(KEY);
    expect(existsSync(secretsFile)).toBe(true);
    await store.clear();
    // No stray empty file left behind (matches the method's stated intent).
    expect(existsSync(secretsFile)).toBe(false);
  });

  test('clear preserves other secrets in the file', async () => {
    const store = new FileEmbeddingsBackend(secretsFile);
    await store.set(KEY);
    // Simulate a co-resident secret written by a future feature.
    const raw = readFileSync(secretsFile, 'utf-8');
    writeFileSync(secretsFile, `${raw}other: keep-me\n`);
    await store.clear();
    expect(await store.get()).toBeNull();
    expect(readFileSync(secretsFile, 'utf-8')).toContain('other: keep-me');
  });

  test('empty / absent file reads as no key', async () => {
    const store = new FileEmbeddingsBackend(secretsFile);
    expect(await store.get()).toBeNull();
  });

  test('get() falls back to a key stored under the legacy `embeddings` field', async () => {
    // A key written by an earlier build (before the rename to OPENAI_API_KEY)
    // must still resolve, not silently vanish.
    mkdirSync(join(dir, '.ok'), { recursive: true });
    writeFileSync(secretsFile, `embeddings: ${KEY}\n`);
    expect(await new FileEmbeddingsBackend(secretsFile).get()).toBe(KEY);
  });

  test('set() migrates the legacy field to OPENAI_API_KEY and drops it (self-clearing)', async () => {
    mkdirSync(join(dir, '.ok'), { recursive: true });
    writeFileSync(secretsFile, 'embeddings: old-key\nother: keep-me\n');
    await new FileEmbeddingsBackend(secretsFile).set(KEY);
    expect(await new FileEmbeddingsBackend(secretsFile).get()).toBe(KEY);
    const data = parse(readFileSync(secretsFile, 'utf-8')) as Record<string, unknown>;
    expect(data.OPENAI_API_KEY).toBe(KEY);
    expect(data.embeddings).toBeUndefined(); // legacy field dropped
    expect(data.other).toBe('keep-me'); // co-resident secrets preserved
  });

  test('clear() removes the legacy field too — no resurrection via the fallback', async () => {
    mkdirSync(join(dir, '.ok'), { recursive: true });
    writeFileSync(secretsFile, `embeddings: ${KEY}\n`);
    const store = new FileEmbeddingsBackend(secretsFile);
    await store.clear();
    expect(await store.get()).toBeNull();
  });
});

describe('makeLazyEmbeddingsKeyStore', () => {
  test('reads the key from the secrets file (file-only, no keychain)', async () => {
    await new FileEmbeddingsBackend(secretsFile).set(KEY);
    const reader = makeLazyEmbeddingsKeyStore(secretsFile);
    expect(await reader.get()).toBe(KEY);
  });

  test('picks up a key written AFTER the reader was created (re-reads each get)', async () => {
    const reader = makeLazyEmbeddingsKeyStore(secretsFile);
    expect(await reader.get()).toBeNull();
    await new FileEmbeddingsBackend(secretsFile).set(KEY);
    expect(await reader.get()).toBe(KEY);
  });

  test('returns null (never throws) when nothing is stored', async () => {
    const reader = makeLazyEmbeddingsKeyStore(secretsFile);
    expect(await reader.get()).toBeNull();
  });
});

describe('describeStoredEmbeddingsKey', () => {
  test('reports the file backend when the key lives there', async () => {
    await new FileEmbeddingsBackend(secretsFile).set(KEY);
    const desc = await describeStoredEmbeddingsKey(secretsFile);
    expect(desc.file).toBe(true);
  });

  test('reports no file backend when nothing is stored', async () => {
    const desc = await describeStoredEmbeddingsKey(secretsFile);
    expect(desc.file).toBe(false);
  });
});

describe('clearEmbeddingsKeyFromAllBackends', () => {
  test('reports the file backend when it held a key', async () => {
    await new FileEmbeddingsBackend(secretsFile).set(KEY);
    const { touched } = await clearEmbeddingsKeyFromAllBackends(secretsFile);
    expect(touched).toContain('file');
    expect(await new FileEmbeddingsBackend(secretsFile).get()).toBeNull();
  });

  test('reports nothing when no key was stored', async () => {
    const { touched } = await clearEmbeddingsKeyFromAllBackends(secretsFile);
    expect(touched).toEqual([]);
  });
});
