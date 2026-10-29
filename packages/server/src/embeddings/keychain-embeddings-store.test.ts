import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import { EmbeddingsSecretStoreError } from './credential-errors.ts';
import { createKeychainEmbeddingsStore, withEmbeddingsLock } from './keychain-embeddings-store.ts';
import {
  canonicalProjectKey,
  createEmbeddingsSecretStore,
  isUnavailableLinuxKeyring,
} from './secrets-store.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ok-keychain-test-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('stores isolated keys outside its listing index and clears all entries', async () => {
  const entries = new Map<string, string>();
  const store = createKeychainEmbeddingsStore(join(dir, 'secrets.yml'), {
    get: async (account) => entries.get(account) ?? null,
    set: async (account, key) => {
      entries.set(account, key);
    },
    clear: async (account) => {
      entries.delete(account);
    },
  });
  await store.setForProject('/one', 'https://api.openai.com/v1', 'secret-one');
  await store.setForProject('/two', 'https://api.openai.com/v1', 'secret-two');
  expect((await store.resolveForProject('/one', 'https://api.openai.com/v1')).key).toBe(
    'secret-one',
  );
  expect(JSON.stringify(await store.listProjects())).not.toContain('secret-one');
  expect(readFileSync(join(dir, 'secrets.yml.embeddings-index'), 'utf8')).not.toContain(
    'secret-one',
  );
  await store.clearAll();
  expect(entries.size).toBe(0);
});

test('migrates a global legacy key without restricting it to the first project', async () => {
  writeFileSync(join(dir, 'secrets.yml'), 'OPENAI_API_KEY: global-secret\nother: kept\n');
  const entries = new Map<string, string>();
  const store = createKeychainEmbeddingsStore(join(dir, 'secrets.yml'), {
    get: async (id) => entries.get(id) ?? null,
    set: async (id, key) => {
      entries.set(id, key);
    },
    clear: async (id) => {
      entries.delete(id);
    },
  });
  expect((await store.resolveForProject('/one', 'https://api.openai.com/v1')).key).toBe(
    'global-secret',
  );
  expect((await store.resolveForProject('/two', 'https://api.openai.com/v1')).key).toBe(
    'global-secret',
  );
  expect((await store.resolveForProject('/two', 'https://custom.example/v1')).key).toBeNull();
  expect(readFileSync(join(dir, 'secrets.yml'), 'utf8')).toContain('other: kept');
  expect(readFileSync(join(dir, 'secrets.yml'), 'utf8')).not.toContain('global-secret');
});

test.each([true, false])(
  'project migration removes plaintext and preserves unrelated data (other=%s)',
  async (withOther) => {
    const path = join(dir, 'secrets.yml');
    const project = canonicalProjectKey(join(dir, 'project'));
    const endpoint = 'https://api.openai.com/v1';
    writeFileSync(
      path,
      stringify({
        ...(withOther ? { other: 'kept' } : {}),
        embeddings_projects: { [project]: { [endpoint]: 'project-secret' } },
      }),
    );
    const entries = new Map<string, string>();
    const store = createEmbeddingsSecretStore(path, {
      get: async (id) => entries.get(id) ?? null,
      set: async (id, key) => {
        entries.set(id, key);
      },
      clear: async (id) => {
        entries.delete(id);
      },
    });
    expect((await store.resolveForProject(project, endpoint)).key).toBe('project-secret');
    expect([...entries.values()]).toContain('project-secret');
    if (withOther) {
      expect(readFileSync(path, 'utf8')).toContain('other: kept');
      expect(readFileSync(path, 'utf8')).not.toContain('project-secret');
      expect(readFileSync(path, 'utf8')).not.toContain('embeddings_projects');
    } else expect(existsSync(path)).toBe(false);
  },
);

test.each(['project', 'legacy'] as const)(
  'preserves both conflicting %s credentials',
  async (kind) => {
    const path = join(dir, 'secrets.yml');
    const project = canonicalProjectKey(join(dir, 'project'));
    const endpoint = 'https://api.openai.com/v1';
    const entries = new Map<string, string>();
    const store = createEmbeddingsSecretStore(path, {
      get: async (id) => entries.get(id) ?? null,
      set: async (id, key) => {
        entries.set(id, key);
      },
      clear: async (id) => {
        entries.delete(id);
      },
    });
    if (kind === 'project') await store.setForProject(project, endpoint, 'native-secret');
    else entries.set('v1-legacy-default', 'native-secret');
    const data =
      kind === 'project'
        ? { embeddings_projects: { [project]: { [endpoint]: 'file-secret' } } }
        : { OPENAI_API_KEY: 'file-secret' };
    writeFileSync(path, stringify(data));
    await expect(store.resolveForProject(project, endpoint)).rejects.toMatchObject({
      code: 'migration_conflict',
    });
    expect(readFileSync(path, 'utf8')).toContain('file-secret');
    expect([...entries.values()]).toContain('native-secret');
  },
);

async function conflictingProjects() {
  const path = join(dir, 'secrets.yml');
  const conflict = canonicalProjectKey(join(dir, 'conflict'));
  const healthy = canonicalProjectKey(join(dir, 'healthy'));
  const endpoint = 'https://api.openai.com/v1';
  const entries = new Map<string, string>();
  const store = createEmbeddingsSecretStore(path, {
    get: async (id) => entries.get(id) ?? null,
    set: async (id, key) => {
      entries.set(id, key);
    },
    clear: async (id) => {
      entries.delete(id);
    },
  });
  await store.setForProject(conflict, endpoint, 'native-conflict');
  writeFileSync(
    path,
    stringify({
      other: 'kept',
      embeddings_projects: {
        [healthy]: { [endpoint]: 'healthy-file' },
        [conflict]: { [endpoint]: 'file-conflict' },
      },
    }),
  );
  return { path, conflict, healthy, endpoint, entries, store };
}

test('explicitly replacing a conflicting slot preserves other projects and becomes usable', async () => {
  const { path, conflict, healthy, endpoint, store } = await conflictingProjects();
  await expect(store.resolveForProject(conflict, endpoint)).rejects.toMatchObject({
    code: 'migration_conflict',
  });
  await store.setForProject(conflict, endpoint, 'replacement');
  expect((await store.resolveForProject(conflict, endpoint)).key).toBe('replacement');
  expect(readFileSync(path, 'utf8')).not.toContain('file-conflict');
  expect((await store.resolveForProject(healthy, endpoint)).key).toBe('healthy-file');
});

test('explicitly clearing a conflicting slot removes both copies without touching another project', async () => {
  const { path, conflict, healthy, endpoint, entries, store } = await conflictingProjects();
  expect(await store.clearForProject(conflict, endpoint)).toBe(true);
  expect(readFileSync(path, 'utf8')).not.toContain('file-conflict');
  expect([...entries.values()]).not.toContain('native-conflict');
  expect((await store.resolveForProject(healthy, endpoint)).key).toBe('healthy-file');
});

test('a conflicting project does not block another project and prior cleanup survives the conflict', async () => {
  const { path, conflict, healthy, endpoint, store } = await conflictingProjects();
  expect((await store.resolveForProject(healthy, endpoint)).key).toBe('healthy-file');
  await expect(store.resolveForProject(conflict, endpoint)).rejects.toMatchObject({
    code: 'migration_conflict',
  });
  expect(readFileSync(path, 'utf8')).not.toContain('healthy-file');
  expect(readFileSync(path, 'utf8')).toContain('file-conflict');
});

test('stored-scope migration keeps the recorded identity when its path is retargeted', async () => {
  const path = join(dir, 'secrets.yml');
  const original = join(dir, 'original');
  const target = join(dir, 'target');
  mkdirSync(original);
  mkdirSync(target);
  const recorded = canonicalProjectKey(original);
  const targetKey = canonicalProjectKey(target);
  renameSync(original, join(dir, 'renamed'));
  symlinkSync(target, original, process.platform === 'win32' ? 'junction' : 'dir');
  const endpoint = 'https://api.openai.com/v1';
  writeFileSync(
    path,
    stringify({
      OPENAI_API_KEY: 'legacy-key',
      embeddings_projects: {
        [recorded]: { [endpoint]: 'recorded-key' },
        [targetKey]: { [endpoint]: 'target-key' },
      },
    }),
  );
  const entries = new Map<string, string>();
  const store = createEmbeddingsSecretStore(path, {
    get: async (id) => entries.get(id) ?? null,
    set: async (id, key) => {
      entries.set(id, key);
    },
    clear: async (id) => {
      entries.delete(id);
    },
  });
  expect((await store.listProjects()).map((entry) => entry.projectKey)).toContain(recorded);
  expect(await store.migrateStoredProject(recorded, endpoint)).toBe(true);
  expect([...entries.values()]).toEqual(['recorded-key']);
  const data = parse(readFileSync(path, 'utf8'));
  expect(data.embeddings_projects[recorded]).toBeUndefined();
  expect(data.embeddings_projects[targetKey][endpoint]).toBe('target-key');
  expect(data.OPENAI_API_KEY).toBe('legacy-key');
  expect(await store.migrateStoredProject(recorded, endpoint)).toBe(true);
});

test('stored-scope migration never substitutes the legacy key for a missing project slot', async () => {
  const path = join(dir, 'secrets.yml');
  const contents = stringify({ OPENAI_API_KEY: 'legacy-key' });
  writeFileSync(path, contents);
  const entries = new Map<string, string>();
  const store = createEmbeddingsSecretStore(path, {
    get: async (id) => entries.get(id) ?? null,
    set: async (id, key) => {
      entries.set(id, key);
    },
    clear: async (id) => {
      entries.delete(id);
    },
  });
  expect(await store.migrateStoredProject('/missing', 'https://api.openai.com/v1')).toBe(false);
  expect(entries.size).toBe(0);
  expect(readFileSync(path, 'utf8')).toBe(contents);
});

test('stored-scope migration reports false on a file-only backend', async () => {
  const path = join(dir, 'secrets.yml');
  const contents = stringify({
    embeddings_projects: { '/one': { 'https://api.openai.com/v1': 'file-key' } },
  });
  writeFileSync(path, contents);
  const store = createEmbeddingsSecretStore(path, undefined, async () => null);
  expect(await store.migrateStoredProject('/one', 'https://api.openai.com/v1')).toBe(false);
  expect(readFileSync(path, 'utf8')).toBe(contents);
});

test('clear-all removes conflicting file and native credentials while retaining unrelated data', async () => {
  const { path, entries, store } = await conflictingProjects();
  expect((await store.clearAll()).touched).toEqual(expect.arrayContaining(['file', 'keychain']));
  expect(entries.size).toBe(0);
  expect(readFileSync(path, 'utf8')).toContain('other: kept');
  expect(readFileSync(path, 'utf8')).not.toContain('file-conflict');
  expect(readFileSync(path, 'utf8')).not.toContain('healthy-file');
});

test.each(['unexpected', { '/project': 'unexpected' }])(
  'clear-all removes malformed reserved project data while preserving unrelated YAML',
  async (malformed) => {
    const path = join(dir, 'secrets.yml');
    const entries = new Map<string, string>();
    const store = createEmbeddingsSecretStore(path, {
      get: async (id) => entries.get(id) ?? null,
      set: async (id, key) => {
        entries.set(id, key);
      },
      clear: async (id) => {
        entries.delete(id);
      },
    });
    await store.setForProject('/one', 'https://api.openai.com/v1', 'native-secret');
    writeFileSync(path, stringify({ other: 'keep-me', embeddings_projects: malformed }));
    expect((await store.clearAll()).touched).toEqual(expect.arrayContaining(['file', 'keychain']));
    expect(entries.size).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe('other: keep-me\n');
  },
);

test.each(['yaml', 'index'] as const)(
  'clear-all preserves credentials and unrelated data when %s is invalid',
  async (invalid) => {
    const path = join(dir, 'secrets.yml');
    const entries = new Map<string, string>();
    const store = createEmbeddingsSecretStore(path, {
      get: async (id) => entries.get(id) ?? null,
      set: async (id, key) => {
        entries.set(id, key);
      },
      clear: async (id) => {
        entries.delete(id);
      },
    });
    await store.setForProject('/one', 'https://api.openai.com/v1', 'native-secret');
    const contents = invalid === 'yaml' ? 'other: [\n' : 'other: keep-me\n';
    writeFileSync(path, contents);
    if (invalid === 'index') writeFileSync(`${path}.embeddings-index`, '{');
    await expect(store.clearAll()).rejects.toMatchObject({
      code: invalid === 'yaml' ? 'file_access' : 'index_invalid',
      cause: { phase: invalid === 'yaml' ? 'file_read' : 'index_read' },
    });
    expect(readFileSync(path, 'utf8')).toBe(contents);
    expect([...entries.values()]).toContain('native-secret');
  },
);

test('listing projects does not migrate or fail on a conflicting entry', async () => {
  const { path, conflict, healthy, endpoint, store } = await conflictingProjects();
  const listing = await store.listProjects();
  expect(listing).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        projectKey: conflict,
        endpoints: expect.arrayContaining([expect.objectContaining({ endpoint })]),
      }),
      expect.objectContaining({
        projectKey: healthy,
        endpoints: expect.arrayContaining([expect.objectContaining({ endpoint })]),
      }),
    ]),
  );
  expect(readFileSync(path, 'utf8')).toContain('file-conflict');
  expect(readFileSync(path, 'utf8')).toContain('healthy-file');
});

test('failed replacement verification retains the existing file credential', async () => {
  const path = join(dir, 'secrets.yml');
  const project = canonicalProjectKey(join(dir, 'project'));
  const endpoint = 'https://api.openai.com/v1';
  writeFileSync(
    path,
    stringify({ embeddings_projects: { [project]: { [endpoint]: 'file-secret' } } }),
  );
  const store = createEmbeddingsSecretStore(path, {
    get: async () => 'native-old',
    set: async () => {},
    clear: async () => {},
  });
  await expect(store.setForProject(project, endpoint, 'replacement')).rejects.toMatchObject({
    code: 'native_access',
    cause: { phase: 'verify' },
  });
  expect(readFileSync(path, 'utf8')).toContain('file-secret');
});

test('a project key overrides a shared legacy conflict without clearing the shared keys', async () => {
  const path = join(dir, 'secrets.yml');
  const endpoint = 'https://api.openai.com/v1';
  writeFileSync(path, stringify({ OPENAI_API_KEY: 'legacy-one', embeddings: 'legacy-two' }));
  const entries = new Map<string, string>();
  const store = createEmbeddingsSecretStore(path, {
    get: async (id) => entries.get(id) ?? null,
    set: async (id, key) => {
      entries.set(id, key);
    },
    clear: async (id) => {
      entries.delete(id);
    },
  });
  await expect(store.resolveForProject('/one', endpoint)).rejects.toMatchObject({
    code: 'migration_conflict',
  });
  await store.setForProject('/one', endpoint, 'project-key');
  expect((await store.resolveForProject('/one', endpoint)).key).toBe('project-key');
  expect(await store.clearForProject('/one', endpoint)).toBe(true);
  await expect(store.resolveForProject('/one', endpoint)).rejects.toMatchObject({
    code: 'migration_conflict',
  });
  expect(readFileSync(path, 'utf8')).toContain('legacy-one');
  expect(readFileSync(path, 'utf8')).toContain('legacy-two');
});

test('clearing a project removes conflicting slots without migrating unrelated projects', async () => {
  const { path, conflict, healthy, endpoint, entries, store } = await conflictingProjects();
  expect(await store.clearAllForProject(conflict)).toBe(true);
  expect([...entries.values()]).not.toContain('native-conflict');
  expect(readFileSync(path, 'utf8')).not.toContain('file-conflict');
  expect(readFileSync(path, 'utf8')).toContain('healthy-file');
  expect((await store.resolveForProject(healthy, endpoint)).key).toBe('healthy-file');
});

test('a shadowed nonempty legacy key remains in the file and reports a conflict', async () => {
  const path = join(dir, 'secrets.yml');
  const contents = stringify({ OPENAI_API_KEY: '', embeddings: 'shadowed-secret', other: 'kept' });
  writeFileSync(path, contents);
  const entries = new Map<string, string>();
  const store = createEmbeddingsSecretStore(path, {
    get: async (id) => entries.get(id) ?? null,
    set: async (id, key) => {
      entries.set(id, key);
    },
    clear: async (id) => {
      entries.delete(id);
    },
  });
  await expect(store.getLegacyKey()).rejects.toMatchObject({ code: 'migration_conflict' });
  expect(readFileSync(path, 'utf8')).toBe(contents);
  expect(entries.size).toBe(0);
});

test.each([
  { OPENAI_API_KEY: 42, embeddings: 'secret' },
  { OPENAI_API_KEY: 'secret', embeddings: { unexpected: true } },
])('non-string legacy fields are retained and reported as invalid', async (fields) => {
  const path = join(dir, 'secrets.yml');
  const contents = stringify({ ...fields, other: 'kept' });
  writeFileSync(path, contents);
  const entries = new Map<string, string>();
  const store = createEmbeddingsSecretStore(path, {
    get: async (id) => entries.get(id) ?? null,
    set: async (id, key) => {
      entries.set(id, key);
    },
    clear: async (id) => {
      entries.delete(id);
    },
  });
  await expect(store.getLegacyKey()).rejects.toMatchObject({
    code: 'file_access',
    cause: { phase: 'file_read' },
  });
  expect(readFileSync(path, 'utf8')).toBe(contents);
  expect(entries.size).toBe(0);
});

test.each(['map', 'slot'] as const)('a null project %s permits setting a key', async (kind) => {
  const path = join(dir, 'secrets.yml');
  const project = canonicalProjectKey(join(dir, 'project'));
  const endpoint = 'https://api.openai.com/v1';
  writeFileSync(
    path,
    stringify({ embeddings_projects: kind === 'map' ? null : { [project]: null }, other: 'kept' }),
  );
  const entries = new Map<string, string>();
  const store = createEmbeddingsSecretStore(path, {
    get: async (id) => entries.get(id) ?? null,
    set: async (id, key) => {
      entries.set(id, key);
    },
    clear: async (id) => {
      entries.delete(id);
    },
  });
  await store.setForProject(project, endpoint, 'project-secret');
  expect((await store.resolveForProject(project, endpoint)).key).toBe('project-secret');
  expect(readFileSync(path, 'utf8')).toContain('other: kept');
});

test.each(['map', 'slot'] as const)(
  'a non-null malformed project %s remains fail-closed',
  async (kind) => {
    const path = join(dir, 'secrets.yml');
    const project = canonicalProjectKey(join(dir, 'project'));
    const contents = stringify({ embeddings_projects: kind === 'map' ? 42 : { [project]: 42 } });
    writeFileSync(path, contents);
    const store = createEmbeddingsSecretStore(path, {
      get: async () => null,
      set: async () => {},
      clear: async () => {},
    });
    await expect(
      store.setForProject(project, 'https://api.openai.com/v1', 'project-secret'),
    ).rejects.toMatchObject({ code: 'file_access' });
    expect(readFileSync(path, 'utf8')).toBe(contents);
  },
);

test('preserves both conflicting legacy file fields', async () => {
  const path = join(dir, 'secrets.yml');
  writeFileSync(path, stringify({ OPENAI_API_KEY: 'first-secret', embeddings: 'second-secret' }));
  const store = createEmbeddingsSecretStore(path, {
    get: async () => null,
    set: async () => {},
    clear: async () => {},
  });
  await expect(store.resolveForProject('/one', 'https://api.openai.com/v1')).rejects.toMatchObject({
    code: 'migration_conflict',
  });
  expect(readFileSync(path, 'utf8')).toContain('first-secret');
  expect(readFileSync(path, 'utf8')).toContain('second-secret');
});

test('does not delete the file credential when native write fails', async () => {
  writeFileSync(join(dir, 'secrets.yml'), 'OPENAI_API_KEY: global-secret\n');
  const store = createKeychainEmbeddingsStore(join(dir, 'secrets.yml'), {
    get: async () => null,
    set: async () => {
      throw new Error('denied');
    },
    clear: async () => {},
  });
  await expect(store.resolveForProject('/one', 'https://api.openai.com/v1')).rejects.toThrow(
    'denied',
  );
  expect(readFileSync(join(dir, 'secrets.yml'), 'utf8')).toContain('global-secret');
});

test('serializes two stores sharing an index without losing either key', async () => {
  const entries = new Map<string, string>();
  const native = {
    get: async (id: string) => entries.get(id) ?? null,
    set: async (id: string, key: string) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      entries.set(id, key);
    },
    clear: async (id: string) => {
      entries.delete(id);
    },
  };
  const path = join(dir, 'secrets.yml');
  const first = createKeychainEmbeddingsStore(path, native);
  const second = createKeychainEmbeddingsStore(path, native);
  await Promise.all([
    first.setForProject('/one', 'https://api.openai.com/v1', 'first-secret'),
    second.setForProject('/two', 'https://api.openai.com/v1', 'second-secret'),
  ]);
  expect(await first.listProjects()).toHaveLength(2);
  expect((await second.resolveForProject('/one', 'https://api.openai.com/v1')).key).toBe(
    'first-secret',
  );
});

test('native read failure does not fall back to an older file key', async () => {
  writeFileSync(join(dir, 'secrets.yml'), 'OPENAI_API_KEY: old-secret\n');
  const store = createKeychainEmbeddingsStore(join(dir, 'secrets.yml'), {
    get: async () => {
      throw new Error('denied');
    },
    set: async () => {},
    clear: async () => {},
  });
  await expect(store.resolveForProject('/one', 'https://api.openai.com/v1')).rejects.toThrow(
    'denied',
  );
  expect(readFileSync(join(dir, 'secrets.yml'), 'utf8')).toContain('old-secret');
});

test('unavailable backend falls back only when no native entries are indexed', async () => {
  const path = join(dir, 'secrets.yml');
  const fallback = createEmbeddingsSecretStore(path, undefined, async () => null);
  await fallback.setForProject('/one', 'https://api.openai.com/v1', 'fallback-secret');
  expect(fallback.backend).toBe('file');
  const entries = new Map<string, string>();
  const secure = createEmbeddingsSecretStore(path, {
    get: async (id) => entries.get(id) ?? null,
    set: async (id, key) => {
      entries.set(id, key);
    },
    clear: async (id) => {
      entries.delete(id);
    },
  });
  expect((await secure.resolveForProject('/one', 'https://api.openai.com/v1')).key).toBe(
    'fallback-secret',
  );
  await expect(
    fallback.setForProject('/one', 'https://api.openai.com/v1', 'stale'),
  ).rejects.toThrow('unavailable or inaccessible');
  expect((await secure.resolveForProject('/one', 'https://api.openai.com/v1')).key).toBe(
    'fallback-secret',
  );
});

test('a denied native read never selects the file fallback or exposes the error', async () => {
  const path = join(dir, 'secrets.yml');
  writeFileSync(path, 'OPENAI_API_KEY: old-secret\n');
  const store = createEmbeddingsSecretStore(path, undefined, async () => ({
    get: async () => {
      throw new Error('sensitive native detail');
    },
    set: async () => {},
    clear: async () => {},
  }));
  const failure = await store
    .resolveForProject('/one', 'https://api.openai.com/v1')
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({
    code: 'native_access',
    message:
      'Embeddings credential store is unavailable or inaccessible. Unlock the OS credential store and try again.',
  });
  expect(JSON.stringify(failure)).not.toContain('sensitive native detail');
  expect(failure).toHaveProperty('cause', { phase: 'native_get', name: 'Error', code: 'unknown' });
  expect(store.backend).toBe('keyring');
  expect(readFileSync(path, 'utf8')).toContain('old-secret');
});

test('fallback rechecks the native index after waiting for an in-flight secure write', async () => {
  const path = join(dir, 'secrets.yml');
  const entries = new Map<string, string>();
  const { promise: entered, resolve: started } = Promise.withResolvers<void>();
  const { promise: resume, resolve: release } = Promise.withResolvers<void>();
  const secure = createEmbeddingsSecretStore(path, {
    get: async (id) => entries.get(id) ?? null,
    set: async (id, key) => {
      started();
      await resume;
      entries.set(id, key);
    },
    clear: async (id) => {
      entries.delete(id);
    },
  });
  const fallback = createEmbeddingsSecretStore(path, undefined, async () => null);
  const writing = secure.setForProject('/one', 'https://api.openai.com/v1', 'native-secret');
  await entered;
  const competing = fallback.setForProject('/one', 'https://api.openai.com/v1', 'old-secret');
  release();
  await writing;
  await expect(competing).rejects.toThrow('unavailable or inaccessible');
  expect((await secure.resolveForProject('/one', 'https://api.openai.com/v1')).key).toBe(
    'native-secret',
  );
});

test('a timed-out migration retains its file secret after the native write settles', async () => {
  vi.useFakeTimers();
  try {
    const path = join(dir, 'secrets.yml');
    writeFileSync(path, 'OPENAI_API_KEY: old-secret\n');
    const { promise: entered, resolve: started } = Promise.withResolvers<void>();
    const { promise: resume, resolve: release } = Promise.withResolvers<void>();
    const entries = new Map<string, string>();
    const store = createEmbeddingsSecretStore(path, {
      get: async (id) => entries.get(id) ?? null,
      set: async (id, key) => {
        started();
        await resume;
        entries.set(id, key);
      },
      clear: async (id) => {
        entries.delete(id);
      },
    });
    const result = store.resolveForProject('/one', 'https://api.openai.com/v1');
    const rejected = expect(result).rejects.toThrow('timed out');
    await entered;
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    release();
    await vi.waitFor(() => expect(entries.size).toBe(1));
    expect(readFileSync(path, 'utf8')).toContain('old-secret');
  } finally {
    vi.useRealTimers();
  }
});

test('a missing required index cannot be mistaken for an empty store or trigger fallback', async () => {
  const path = join(dir, 'secrets.yml');
  writeFileSync(`${path}.embeddings-index.required`, '');
  const unavailable = createEmbeddingsSecretStore(path, undefined, async () => null);
  await expect(unavailable.listProjects()).rejects.toThrow('unavailable or inaccessible');
  const secure = createEmbeddingsSecretStore(path, {
    get: async () => null,
    set: async () => {},
    clear: async () => {},
  });
  await expect(secure.listProjects()).rejects.toMatchObject({ code: 'index_invalid' });
});

test('a slow native read returns a sanitized timeout before the three-second UI deadline', async () => {
  vi.useFakeTimers();
  const { promise: entered, resolve: started } = Promise.withResolvers<void>();
  const { promise: resume, resolve: release } = Promise.withResolvers<void>();
  const path = join(dir, 'secrets.yml');
  try {
    const store = createEmbeddingsSecretStore(path, {
      get: async () => {
        started();
        await resume;
        return null;
      },
      set: async () => {},
      clear: async () => {},
    });
    const result = store.resolveForProject('/one', 'https://api.openai.com/v1');
    const rejected = expect(result).rejects.toMatchObject({ code: 'timeout' });
    await entered;
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
  } finally {
    release();
    vi.useRealTimers();
    await withEmbeddingsLock(path, async () => {});
  }
});

test.each(['get', 'set', 'clear'] as const)(
  'native %s errors retain only allowlisted diagnostic metadata',
  async (phase) => {
    const path = join(dir, 'secrets.yml');
    const hostile = Object.assign(new Error('sk-hidden-message'), {
      name: 'sk-hidden-name',
      code: 'sk-hidden-code',
    });
    const known = Object.assign(new Error('sk-hidden-message'), { code: 'GenericFailure' });
    for (const error of [hostile, known]) {
      const store = createEmbeddingsSecretStore(path, {
        get: async () => {
          if (phase === 'get') throw error;
          return phase === 'clear' ? 'present' : null;
        },
        set: async () => {
          if (phase === 'set') throw error;
        },
        clear: async () => {
          if (phase === 'clear') throw error;
        },
      });
      const operation =
        phase === 'get'
          ? store.resolveForProject('/one', 'https://api.openai.com/v1')
          : phase === 'set'
            ? store.setForProject('/one', 'https://api.openai.com/v1', 'test-key')
            : store.clearForProject('/one', 'https://api.openai.com/v1');
      const failure = await operation.catch((value: unknown) => value);
      expect(failure).toMatchObject({
        code: 'native_access',
        cause: {
          phase: `native_${phase}`,
          name: error === known ? 'Error' : 'unknown',
          code: error === known ? 'GenericFailure' : 'unknown',
        },
      });
      expect(JSON.stringify(failure)).not.toContain('sk-hidden');
      expect(String((failure as Error).stack)).not.toContain('sk-hidden');
      expect(JSON.stringify((failure as Error).cause)).not.toContain('sk-hidden');
      expect((failure as Error).cause).not.toHaveProperty('message');
      expect((failure as Error).cause).not.toHaveProperty('stack');
    }
  },
);

test('a module loading failure has a sanitized load phase', async () => {
  vi.doMock('@napi-rs/keyring', () => ({
    get AsyncEntry() {
      throw Object.assign(new Error('sk-hidden-load'), { code: 'ERR_MODULE_NOT_FOUND' });
    },
  }));
  try {
    const store = createEmbeddingsSecretStore(join(dir, 'secrets.yml'));
    const failure = await store
      .resolveForProject('/one', 'https://api.openai.com/v1')
      .catch((value: unknown) => value);
    expect(failure).toMatchObject({ code: 'native_access' });
    expect((failure as Error).cause).toEqual({
      phase: 'load',
      name: 'Error',
      code: 'ERR_MODULE_NOT_FOUND',
    });
    expect(JSON.stringify(failure)).not.toContain('sk-hidden-load');
    expect(String((failure as Error).stack)).not.toContain('sk-hidden-load');
  } finally {
    vi.doUnmock('@napi-rs/keyring');
  }
});

test('the facade preserves an already-sanitized typed cause', async () => {
  const original = new EmbeddingsSecretStoreError(
    'index_invalid',
    'index_read',
    new SyntaxError('sk-hidden'),
  );
  const store = createEmbeddingsSecretStore(join(dir, 'secrets.yml'), undefined, async () => {
    throw original;
  });
  const result = await store
    .resolveForProject('/one', 'https://api.openai.com/v1')
    .catch((error: unknown) => error);
  expect(result).toBe(original);
  expect(original.cause).toEqual({ phase: 'index_read', name: 'SyntaxError', code: 'unknown' });
  expect(JSON.stringify(original.cause)).not.toContain('sk-hidden');
  expect(Reflect.set(original, 'cause', new Error('sk-hidden'))).toBe(false);
  expect(Reflect.set(original, 'code', 'sk-hidden')).toBe(false);
  expect(Object.isFrozen(original.cause)).toBe(true);
});

test('initializer failures do not downgrade to plaintext storage', async () => {
  const path = join(dir, 'secrets.yml');
  const store = createEmbeddingsSecretStore(path, undefined, async () => {
    throw new Error('denied');
  });
  await expect(store.setForProject('/one', 'https://api.openai.com/v1', 'secret')).rejects.toThrow(
    'unavailable or inaccessible',
  );
  expect(() => readFileSync(path, 'utf8')).toThrow();
});

test('a long-lived reader migrates its fallback key when native storage becomes available', async () => {
  const path = join(dir, 'secrets.yml');
  const entries = new Map<string, string>();
  const native = {
    get: async (id: string) => entries.get(id) ?? null,
    set: async (id: string, key: string) => {
      entries.set(id, key);
    },
    clear: async (id: string) => {
      entries.delete(id);
    },
  };
  let available = false;
  const store = createEmbeddingsSecretStore(path, undefined, async () =>
    available ? native : null,
  );
  await store.setForProject('/one', 'https://api.openai.com/v1', 'fallback-secret');
  expect(store.backend).toBe('file');
  available = true;
  const fresh = createEmbeddingsSecretStore(path, native);
  expect((await fresh.resolveForProject('/one', 'https://api.openai.com/v1')).key).toBe(
    'fallback-secret',
  );
  expect((await store.resolveForProject('/one', 'https://api.openai.com/v1')).key).toBe(
    'fallback-secret',
  );
  expect(store.backend).toBe('keyring');
  expect([...entries.values()]).toContain('fallback-secret');
});

test('a long-lived reader retries initialization after a failure without writing plaintext', async () => {
  const path = join(dir, 'secrets.yml');
  const entries = new Map<string, string>();
  const native = {
    get: async (id: string) => entries.get(id) ?? null,
    set: async (id: string, key: string) => {
      entries.set(id, key);
    },
    clear: async (id: string) => {
      entries.delete(id);
    },
  };
  let available = false;
  const store = createEmbeddingsSecretStore(path, undefined, async () => {
    if (!available) throw new Error('denied');
    return native;
  });
  await expect(
    store.setForProject('/one', 'https://api.openai.com/v1', 'secure-secret'),
  ).rejects.toThrow('unavailable or inaccessible');
  expect(() => readFileSync(path, 'utf8')).toThrow();
  available = true;
  await store.setForProject('/one', 'https://api.openai.com/v1', 'secure-secret');
  expect([...entries.values()]).toContain('secure-secret');
  expect(() => readFileSync(path, 'utf8')).toThrow();
});

test('only verified Linux constructor absence diagnostics permit fallback', () => {
  const noBus =
    'Platform failure: DBus error: Using X11 for dbus-daemon autolaunch was disabled at compile time, set your DBUS_SESSION_BUS_ADDRESS instead';
  const noService =
    'Platform failure: DBus error: The name org.freedesktop.secrets was not provided by any .service files';
  const failure = (message: string, code = 'GenericFailure') =>
    Object.assign(new Error(message), { code });
  expect(isUnavailableLinuxKeyring(failure(noBus), 'linux')).toBe(true);
  expect(isUnavailableLinuxKeyring(failure(noService), 'linux')).toBe(true);
  expect(isUnavailableLinuxKeyring(failure(`${noBus}.`), 'linux')).toBe(false);
  expect(isUnavailableLinuxKeyring(failure(noService, 'Other'), 'linux')).toBe(false);
  expect(isUnavailableLinuxKeyring(failure(noService), 'darwin')).toBe(false);
  expect(
    isUnavailableLinuxKeyring(
      failure('Platform failure: User interaction is not allowed'),
      'darwin',
    ),
  ).toBe(false);
});

test('an index without its marker remains safe to clear after interrupted initialization or cleanup', async () => {
  const path = join(dir, 'secrets.yml');
  writeFileSync(`${path}.embeddings-index`, '{}');
  const fallback = createEmbeddingsSecretStore(path, undefined, async () => null);
  await expect(fallback.listProjects()).rejects.toThrow('unavailable or inaccessible');
  const secure = createEmbeddingsSecretStore(path, {
    get: async () => null,
    set: async () => {},
    clear: async () => {},
  });
  expect(await secure.clearAll()).toEqual({ touched: [] });
  await fallback.setForProject('/one', 'https://api.openai.com/v1', 'secret');
  expect(fallback.backend).toBe('file');
});

test('a timed-out queued writer cannot mutate the index later', async () => {
  vi.useFakeTimers();
  const { promise: resume, resolve: release } = Promise.withResolvers<void>();
  try {
    const path = join(dir, 'secrets.yml');
    const { promise: entered, resolve: started } = Promise.withResolvers<void>();
    const native = {
      get: async () => null,
      set: async () => {
        started();
        await resume;
      },
      clear: async () => {},
    };
    const first = createEmbeddingsSecretStore(path, native);
    const second = createEmbeddingsSecretStore(path, native);
    const writing = first.setForProject('/one', 'https://api.openai.com/v1', 'one');
    const firstResult = expect(writing).rejects.toThrow('timed out');
    await entered;
    const before = readFileSync(`${path}.embeddings-index`, 'utf8');
    const queued = second.setForProject('/two', 'https://api.openai.com/v1', 'two');
    const secondResult = expect(queued).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([firstResult, secondResult]);
    release();
    vi.useRealTimers();
    await withEmbeddingsLock(path, async () => {});
    expect(readFileSync(`${path}.embeddings-index`, 'utf8')).toBe(before);
  } finally {
    release?.();
    vi.useRealTimers();
  }
});

test('a killed credential writer releases its SQLite lock for another process', async () => {
  const path = join(dir, 'secrets.yml');
  const helper = fileURLToPath(new URL('./keychain-crash.test-helper.ts', import.meta.url));
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--conditions=@inkeep/source', helper, path],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    if (stdout.includes('READY\n')) ready.resolve();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.once('error', (error) => ready.reject(error));
  child.once('close', (code, signal) => {
    closed.resolve({ code, signal });
    ready.reject(
      new Error(`Credential writer exited before readiness: ${code ?? signal}; ${stderr}`),
    );
  });
  async function bounded<T>(work: Promise<T>, phase: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Credential writer ${phase} timed out: ${stderr}`)),
            15_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  try {
    await bounded(ready.promise, 'readiness');
    const contention = await withEmbeddingsLock(path, async () => 'acquired').catch(
      (error: unknown) => error,
    );
    expect(
      contention,
      `child exit=${child.exitCode}, signal=${child.signalCode}, stderr=${stderr}`,
    ).toMatchObject({ code: 'lock_timeout' });
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(child.kill('SIGKILL')).toBe(true);
    expect((await bounded(closed.promise, 'exit')).signal).toBe('SIGKILL');
    const entries = new Map<string, string>();
    const survivor = createEmbeddingsSecretStore(path, {
      get: async (id) => entries.get(id) ?? null,
      set: async (id, key) => {
        entries.set(id, key);
      },
      clear: async (id) => {
        entries.delete(id);
      },
    });
    await survivor.setForProject('/survivor', 'https://api.openai.com/v1', 'survivor-test-key');
    expect((await survivor.resolveForProject('/survivor', 'https://api.openai.com/v1')).key).toBe(
      'survivor-test-key',
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await bounded(closed.promise, 'cleanup');
  }
}, 30_000);
