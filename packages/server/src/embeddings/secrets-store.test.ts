import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import {
  canonicalProjectKey,
  clearAllEmbeddingsKeys,
  describeStoredEmbeddingsKey,
  FileEmbeddingsBackend,
  makeLazyEmbeddingsKeyStore,
} from './secrets-store.ts';

const KEY = 'sk-secret-embeddings-key-1234567890';
const KEY_2 = 'sk-second-embeddings-key-0987654321';
const OPENAI = 'https://api.openai.com/v1';
const CUSTOM = 'https://my-vllm.internal/v1';
const _LOCAL = 'http://localhost:11434/v1';

let dir: string;
let secretsFile: string;
let projectA: string;
let projectB: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-embkey-')));
  secretsFile = join(dir, '.ok', 'secrets.yml');
  projectA = join(dir, 'project-a');
  projectB = join(dir, 'project-b');
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function store(): FileEmbeddingsBackend {
  return new FileEmbeddingsBackend(secretsFile);
}

describe('FileEmbeddingsBackend — project + endpoint scoped', () => {
  test('set → resolve round-trips a project+endpoint key', async () => {
    const s = store();
    expect((await s.resolveForProject(projectA, CUSTOM)).key).toBeNull();
    await s.setForProject(projectA, CUSTOM, KEY);
    const resolved = await s.resolveForProject(projectA, CUSTOM);
    expect(resolved.key).toBe(KEY);
    expect(resolved.source).toBe('project');
  });

  test('a key is bound to the endpoint it was set for — never travels to another', async () => {
    const s = store();
    await s.setForProject(projectA, CUSTOM, KEY);
    expect((await s.resolveForProject(projectA, 'https://other.host/v1')).key).toBeNull();
  });

  test('different projects hold different keys for the same endpoint', async () => {
    const s = store();
    await s.setForProject(projectA, CUSTOM, KEY);
    await s.setForProject(projectB, CUSTOM, KEY_2);
    expect((await s.resolveForProject(projectA, CUSTOM)).key).toBe(KEY);
    expect((await s.resolveForProject(projectB, CUSTOM)).key).toBe(KEY_2);
  });

  test('replacing a key overwrites in place; other endpoints of the project survive', async () => {
    const s = store();
    await s.setForProject(projectA, OPENAI, KEY);
    await s.setForProject(projectA, CUSTOM, KEY_2);
    await s.setForProject(projectA, OPENAI, 'sk-replaced');
    expect((await s.resolveForProject(projectA, OPENAI)).key).toBe('sk-replaced');
    expect((await s.resolveForProject(projectA, CUSTOM)).key).toBe(KEY_2);
  });

  test('clearForProject removes only that endpoint; returns whether one existed', async () => {
    const s = store();
    await s.setForProject(projectA, OPENAI, KEY);
    await s.setForProject(projectA, CUSTOM, KEY_2);
    expect(await s.clearForProject(projectA, CUSTOM)).toBe(true);
    expect((await s.resolveForProject(projectA, CUSTOM)).key).toBeNull();
    expect((await s.resolveForProject(projectA, OPENAI)).key).toBe(KEY);
    expect(await s.clearForProject(projectA, CUSTOM)).toBe(false);
  });

  test('endpoint identity is normalized — trailing slash / case do not create a miss', async () => {
    const s = store();
    await s.setForProject(projectA, 'https://API.OpenAI.com/v1', KEY);
    expect((await s.resolveForProject(projectA, 'https://api.openai.com/v1/')).key).toBe(KEY);
  });
});

describe('legacy flat key — default-OpenAI-host-only fallback', () => {
  test('a flat OPENAI_API_KEY resolves for the DEFAULT endpoint (grandfathering)', async () => {
    mkdirSync(join(dir, '.ok'), { recursive: true });
    writeFileSync(secretsFile, `OPENAI_API_KEY: ${KEY}\n`);
    const resolved = await store().resolveForProject(projectA, OPENAI);
    expect(resolved.key).toBe(KEY);
    expect(resolved.source).toBe('file');
  });

  test('the flat key does NOT leak to a custom endpoint', async () => {
    mkdirSync(join(dir, '.ok'), { recursive: true });
    writeFileSync(secretsFile, `OPENAI_API_KEY: ${KEY}\n`);
    expect((await store().resolveForProject(projectA, CUSTOM)).key).toBeNull();
  });

  test('a project key for the default endpoint wins over the flat key', async () => {
    mkdirSync(join(dir, '.ok'), { recursive: true });
    writeFileSync(secretsFile, `OPENAI_API_KEY: ${KEY}\n`);
    const s = store();
    await s.setForProject(projectA, OPENAI, KEY_2);
    expect((await s.resolveForProject(projectA, OPENAI)).key).toBe(KEY_2);
  });

  test('the legacy `embeddings` field is also read as the default-host fallback', async () => {
    mkdirSync(join(dir, '.ok'), { recursive: true });
    writeFileSync(secretsFile, `embeddings: ${KEY}\n`);
    expect((await store().resolveForProject(projectA, OPENAI)).key).toBe(KEY);
  });
});

describe('file permissions + atomic writes', () => {
  test('writes the secrets file 0600', async () => {
    await store().setForProject(projectA, CUSTOM, KEY);
    expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
  });

  test('re-asserts 0600 on a pre-existing looser file', async () => {
    mkdirSync(join(dir, '.ok'), { recursive: true });
    writeFileSync(secretsFile, 'other: keep-me\n');
    chmodSync(secretsFile, 0o644);
    await store().setForProject(projectA, CUSTOM, KEY);
    expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
    expect(parse(readFileSync(secretsFile, 'utf-8')).other).toBe('keep-me');
  });

  test('resolve self-heals a world-readable file to 0600 on the read path', async () => {
    mkdirSync(join(dir, '.ok'), { recursive: true });
    writeFileSync(secretsFile, `OPENAI_API_KEY: ${KEY}\n`);
    chmodSync(secretsFile, 0o644);
    await store().resolveForProject(projectA, OPENAI);
    expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
  });

  test('picks up a key written AFTER the reader was created (re-reads each call)', async () => {
    const reader = makeLazyEmbeddingsKeyStore(secretsFile);
    expect((await reader.resolveForProject(projectA, CUSTOM)).key).toBeNull();
    await store().setForProject(projectA, CUSTOM, KEY);
    expect((await reader.resolveForProject(projectA, CUSTOM)).key).toBe(KEY);
  });
});

describe('clear semantics', () => {
  test('clearForProject unlinks the file when it empties the whole store', async () => {
    const s = store();
    await s.setForProject(projectA, CUSTOM, KEY);
    await s.clearForProject(projectA, CUSTOM);
    expect(existsSync(secretsFile)).toBe(false);
  });

  test('clearForProject keeps unrelated top-level secrets', async () => {
    mkdirSync(join(dir, '.ok'), { recursive: true });
    writeFileSync(secretsFile, 'other: keep-me\n');
    const s = store();
    await s.setForProject(projectA, CUSTOM, KEY);
    await s.clearForProject(projectA, CUSTOM);
    expect(parse(readFileSync(secretsFile, 'utf-8')).other).toBe('keep-me');
  });

  test('clearAll wipes every project + the legacy flat key', async () => {
    mkdirSync(join(dir, '.ok'), { recursive: true });
    writeFileSync(secretsFile, `OPENAI_API_KEY: ${KEY}\n`);
    const s = store();
    await s.setForProject(projectA, CUSTOM, KEY);
    await s.setForProject(projectB, OPENAI, KEY_2);
    const { touched } = await clearAllEmbeddingsKeys(secretsFile);
    expect(touched).toEqual(['file']);
    expect(existsSync(secretsFile)).toBe(false);
    expect(await clearAllEmbeddingsKeys(secretsFile)).toEqual({ touched: [] });
  });
});

describe('describe + list + canonicalProjectKey', () => {
  test('describeStoredEmbeddingsKey reports presence + redacted hint, never the key', async () => {
    await store().setForProject(projectA, CUSTOM, KEY);
    const desc = await describeStoredEmbeddingsKey(projectA, CUSTOM, secretsFile);
    expect(desc.present).toBe(true);
    expect(desc.hint).toBe(KEY.slice(-4));
    expect(JSON.stringify(desc)).not.toContain(KEY);
  });

  test('listProjects enumerates every project + endpoint with a redacted hint', async () => {
    const s = store();
    await s.setForProject(projectA, CUSTOM, KEY);
    await s.setForProject(projectB, OPENAI, KEY_2);
    const listed = await s.listProjects();
    expect(listed).toHaveLength(2);
    const endpoints = listed.flatMap((p) => p.endpoints.map((e) => e.endpoint)).sort();
    expect(endpoints).toEqual([CUSTOM, OPENAI].sort());
    expect(JSON.stringify(listed)).not.toContain(KEY);
  });

  test('canonicalProjectKey resolves a symlinked dir to its real path', () => {
    const link = join(dir, 'link-to-a');
    symlinkSync(projectA, link);
    expect(canonicalProjectKey(link)).toBe(canonicalProjectKey(projectA));
  });

  test('a symlinked project and its real path share one key slot', async () => {
    const link = join(dir, 'link-to-a');
    symlinkSync(projectA, link);
    const s = store();
    await s.setForProject(link, CUSTOM, KEY);
    expect((await s.resolveForProject(projectA, CUSTOM)).key).toBe(KEY);
  });
});
