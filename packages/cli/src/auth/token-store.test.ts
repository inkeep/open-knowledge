import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fsSeam = vi.hoisted(() => ({
  stopMessage: 'process stopped partway through a file write',
  keepBytes: null as null | ((byteLength: number) => number),
  stopped: false,
  writes: null as null | Array<{ path: string; mode: number; text: string }>,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const stoppedMutators = Object.fromEntries(
    (
      [
        'appendFileSync',
        'chmodSync',
        'copyFileSync',
        'renameSync',
        'rmSync',
        'truncateSync',
        'unlinkSync',
        'writeSync',
      ] as const
    ).map((name) => [
      name,
      (...args: unknown[]) => {
        if (fsSeam.stopped) throw new Error(fsSeam.stopMessage);
        return (actual[name] as (...forwarded: unknown[]) => unknown)(...args);
      },
    ]),
  );
  const writeFileSync: typeof actual.writeFileSync = (file, data, options) => {
    if (fsSeam.stopped) throw new Error(fsSeam.stopMessage);
    const keepBytes = fsSeam.keepBytes;
    if (keepBytes !== null) {
      fsSeam.keepBytes = null;
      const bytes =
        typeof data === 'string'
          ? Buffer.from(data, 'utf-8')
          : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      actual.writeFileSync(file, bytes.subarray(0, keepBytes(bytes.byteLength)), options);
      fsSeam.stopped = true;
      throw new Error(fsSeam.stopMessage);
    }
    actual.writeFileSync(file, data, options);
    if (fsSeam.writes !== null && typeof file === 'string') {
      fsSeam.writes.push({
        path: file,
        mode: actual.statSync(file).mode & 0o777,
        text: actual.readFileSync(file, 'utf-8'),
      });
    }
  };
  return { ...actual, ...stoppedMutators, writeFileSync };
});

type RecordedWrite = NonNullable<typeof fsSeam.writes>[number];

interface KeyringCall {
  service: string;
  account: string;
}
interface SetPasswordCall extends KeyringCall {
  value: string;
}

const keyringMockState = {
  throwOnImport: false,
  throwOnConstruct: false,
  throwOnGetPassword: false,
  setPasswordCalls: [] as SetPasswordCall[],
  deletePasswordCalls: [] as KeyringCall[],
  getPasswordCalls: [] as KeyringCall[],
  getPasswordReturns: new Map<string, string | null>(),
};

function resetKeyringMockState(): void {
  keyringMockState.throwOnImport = false;
  keyringMockState.throwOnConstruct = false;
  keyringMockState.throwOnGetPassword = false;
  keyringMockState.setPasswordCalls = [];
  keyringMockState.deletePasswordCalls = [];
  keyringMockState.getPasswordCalls = [];
  keyringMockState.getPasswordReturns.clear();
}

class MockKeyringEntry {
  constructor(
    private readonly service: string,
    private readonly account: string,
  ) {
    if (keyringMockState.throwOnConstruct || keyringMockState.throwOnImport) {
      throw new Error(
        keyringMockState.throwOnImport ? 'keyring unavailable' : 'entry construct failed',
      );
    }
  }
  setPassword(value: string): void {
    keyringMockState.setPasswordCalls.push({
      service: this.service,
      account: this.account,
      value,
    });
  }
  getPassword(): string | null {
    keyringMockState.getPasswordCalls.push({
      service: this.service,
      account: this.account,
    });
    if (keyringMockState.throwOnGetPassword) {
      throw new Error('keychain read denied');
    }
    return keyringMockState.getPasswordReturns.get(`${this.service}:${this.account}`) ?? null;
  }
  deletePassword(): void {
    keyringMockState.deletePasswordCalls.push({
      service: this.service,
      account: this.account,
    });
  }
}

vi.doMock('@napi-rs/keyring', () => ({ Entry: MockKeyringEntry }));

import { FileBackend } from './token-store.ts';

describe('FileBackend', () => {
  let tmpDir: string;
  let authFile: string;
  let store: FileBackend;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-token-store-test-'));
    authFile = join(tmpDir, 'auth.yml');
    store = new FileBackend(authFile);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('backend property is "file"', () => {
    expect(store.backend).toBe('file');
  });

  test('get() returns null when file does not exist', async () => {
    expect(await store.get('github.com')).toBeNull();
  });

  test('set() and get() round-trip', async () => {
    await store.set('github.com', 'alice', 'gho_abc123');
    const entry = await store.get('github.com');
    expect(entry).toMatchObject({ login: 'alice', token: 'gho_abc123' });
  });

  test('set() with extra fields stores them', async () => {
    await store.set('github.com', 'alice', 'gho_abc123', {
      gitProtocol: 'https',
      name: 'Alice Example',
      email: 'alice@example.com',
    });
    const entry = await store.get('github.com');
    expect(entry).toMatchObject({
      login: 'alice',
      token: 'gho_abc123',
      gitProtocol: 'https',
      name: 'Alice Example',
      email: 'alice@example.com',
    });
  });

  test('multiple hosts stored independently', async () => {
    await store.set('github.com', 'alice', 'gho_abc');
    await store.set('gitlab.com', 'bob', 'glpat_xyz');
    expect((await store.get('github.com'))?.login).toBe('alice');
    expect((await store.get('gitlab.com'))?.login).toBe('bob');
  });

  test('clear() removes entry', async () => {
    await store.set('github.com', 'alice', 'gho_abc123');
    await store.clear('github.com');
    expect(await store.get('github.com')).toBeNull();
  });

  test('clear() on non-existent entry does not throw', async () => {
    await expect(store.clear('nonexistent.com')).resolves.toBeUndefined();
  });

  test('set() overwrites previous value', async () => {
    await store.set('github.com', 'alice', 'gho_old');
    await store.set('github.com', 'alice', 'gho_new');
    const entry = await store.get('github.com');
    expect(entry?.token).toBe('gho_new');
  });

  test('auth.yml file has mode 0600', async () => {
    await store.set('github.com', 'alice', 'gho_abc123');
    const stat = Bun.file(authFile);
    expect(await stat.exists()).toBe(true);
    const { statSync } = await import('node:fs');
    const mode = statSync(authFile).mode & 0o777;
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o600);
    }
  });

  test('file contents are valid YAML with hostname keys', async () => {
    await store.set('github.com', 'alice', 'gho_abc123');
    await store.set('gitlab.com', 'bob', 'glpat_xyz');
    const raw = readFileSync(authFile, 'utf-8');
    expect(raw).toContain('github.com');
    expect(raw).toContain('gitlab.com');
    expect(raw).toContain('gho_abc123');
    expect(raw).toContain('glpat_xyz');
  });

  test('get() returns null for non-stored host after writing other hosts', async () => {
    await store.set('github.com', 'alice', 'gho_abc');
    expect(await store.get('bitbucket.org')).toBeNull();
  });

  test('handles corrupt YAML file gracefully', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(authFile, '{{{{ not valid yaml }}}}');
    expect(await store.get('github.com')).toBeNull();
  });

  test('creates parent directory if missing', async () => {
    const nestedFile = join(tmpDir, 'deep', 'nested', 'auth.yml');
    const nestedStore = new FileBackend(nestedFile);
    await nestedStore.set('github.com', 'alice', 'gho_abc');
    expect(await nestedStore.get('github.com')).toMatchObject({ login: 'alice' });
  });
});

const SEEDED_AUTH_YML = [
  'github.com:',
  '  login: alice',
  '  token: gho_alice',
  'gitlab.com:',
  '  login: bob',
  '  token: glpat_bob',
  '',
].join('\n');

const SEEDED_ENTRIES = {
  'github.com': { login: 'alice', token: 'gho_alice' },
  'gitlab.com': { login: 'bob', token: 'glpat_bob' },
};

const CREDENTIAL_TOKENS = ['gho_alice', 'glpat_bob', 'cb_carol'];

const authFileWrites = [
  {
    operation: 'set()',
    run: (store: FileBackend) => store.set('codeberg.org', 'carol', 'cb_carol'),
  },
  { operation: 'clear()', run: (store: FileBackend) => store.clear('github.com') },
];

const stopPoints = [
  { at: 'before its first byte', keepBytes: () => 0 },
  { at: 'halfway through', keepBytes: (byteLength: number) => Math.floor(byteLength / 2) },
  { at: 'one byte before the end', keepBytes: (byteLength: number) => byteLength - 1 },
];

describe.each(authFileWrites)('FileBackend $operation auth.yml write', ({ run }) => {
  let tmpDir: string;
  let authFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-token-store-write-'));
    authFile = join(tmpDir, 'auth.yml');
    writeFileSync(authFile, SEEDED_AUTH_YML, { mode: 0o600 });
  });

  afterEach(() => {
    fsSeam.keepBytes = null;
    fsSeam.stopped = false;
    fsSeam.writes = null;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test.each(stopPoints)(
    'stopped $at leaves every previous entry readable and the file bytes unchanged',
    async ({ keepBytes }) => {
      fsSeam.keepBytes = keepBytes;
      await expect(run(new FileBackend(authFile))).rejects.toThrow(fsSeam.stopMessage);

      const reopened = new FileBackend(authFile);
      expect({
        'github.com': await reopened.get('github.com'),
        'gitlab.com': await reopened.get('gitlab.com'),
      }).toEqual(SEEDED_ENTRIES);
      expect(readFileSync(authFile, 'utf-8')).toBe(SEEDED_AUTH_YML);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'leaves a group-readable auth.yml holding credentials at mode 0600',
    async () => {
      chmodSync(authFile, 0o644);

      await run(new FileBackend(authFile));

      expect(await new FileBackend(authFile).get('gitlab.com')).toEqual(
        SEEDED_ENTRIES['gitlab.com'],
      );
      expect((statSync(authFile).mode & 0o777).toString(8)).toBe('600');
    },
  );

  test.skipIf(process.platform === 'win32')(
    'puts credential bytes only into files without group or other permission bits',
    async () => {
      chmodSync(authFile, 0o644);
      const writes: RecordedWrite[] = [];
      fsSeam.writes = writes;

      await run(new FileBackend(authFile));

      const holdingCredentials = writes.filter((write) =>
        CREDENTIAL_TOKENS.some((token) => write.text.includes(token)),
      );
      expect(holdingCredentials.length).toBeGreaterThan(0);
      expect(
        holdingCredentials
          .filter((write) => (write.mode & 0o077) !== 0)
          .map((write) => `${basename(write.path)} mode ${write.mode.toString(8)}`),
      ).toEqual([]);
    },
  );
});

describe('createTokenStore', () => {
  beforeEach(resetKeyringMockState);

  test('returns a store with a recognised backend property', async () => {
    const { createTokenStore } = await import('./token-store.ts');
    const store = await createTokenStore(
      join(mkdtempSync(join(tmpdir(), 'ok-ts-smoke-')), 'auth.yml'),
    );
    expect(['keyring', 'file']).toContain(store.backend);
    expect(typeof store.get).toBe('function');
    expect(typeof store.set).toBe('function');
    expect(typeof store.clear).toBe('function');
  });
});

describe('createTokenStore diagnostics', () => {
  let tmpDir: string;

  beforeEach(() => {
    resetKeyringMockState();
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-ts-diag-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('onBackendSelected reports keyring when the native module loads', async () => {
    const { createTokenStore } = await import('./token-store.ts');
    const selected: Array<{ backend: string; reason?: string }> = [];
    await createTokenStore(join(tmpDir, 'auth.yml'), {
      onBackendSelected: (info) => selected.push(info),
    });
    expect(selected).toEqual([{ backend: 'keyring' }]);
  });

  test('onBackendSelected reports file + reason when keyring is unavailable', async () => {
    keyringMockState.throwOnImport = true;
    const { createTokenStore } = await import('./token-store.ts');
    const selected: Array<{ backend: string; reason?: string }> = [];
    await createTokenStore(join(tmpDir, 'auth.yml'), {
      onBackendSelected: (info) => selected.push(info),
    });
    expect(selected).toHaveLength(1);
    expect(selected[0]?.backend).toBe('file');
    expect(selected[0]?.reason).toContain('keyring unavailable');
  });

  test('onKeychainRead reports absent when no credential is stored', async () => {
    const { createTokenStore } = await import('./token-store.ts');
    const reads: Array<{ kind: string; host: string; error?: string }> = [];
    const store = await createTokenStore(join(tmpDir, 'auth.yml'), {
      onKeychainRead: (info) => reads.push(info),
    });
    const entry = await store.get('github.com');
    expect(entry).toBeNull();
    expect(reads).toEqual([{ kind: 'absent', host: 'github.com' }]);
  });

  test('onKeychainRead reports read-error with the error NAME only when getPassword throws', async () => {
    keyringMockState.throwOnGetPassword = true;
    const { createTokenStore } = await import('./token-store.ts');
    const reads: Array<{ kind: string; host: string; error?: string }> = [];
    const store = await createTokenStore(join(tmpDir, 'auth.yml'), {
      onKeychainRead: (info) => reads.push(info),
    });
    const entry = await store.get('github.com');
    expect(entry).toBeNull();
    expect(reads).toHaveLength(1);
    expect(reads[0]?.kind).toBe('read-error');
    expect(reads[0]?.host).toBe('github.com');
    expect(reads[0]?.error).toBe('Error');
    expect(JSON.stringify(reads)).not.toContain('keychain read denied');
  });

  test('onKeychainRead reports corrupt-entry (no stored bytes) when JSON.parse fails', async () => {
    const TOKEN_BYTES = 'gho_corrupt_secret_value_xyz';
    keyringMockState.getPasswordReturns.set(`open-knowledge:github.com`, TOKEN_BYTES);
    const { createTokenStore } = await import('./token-store.ts');
    const reads: Array<{ kind: string; host: string; error?: string }> = [];
    const store = await createTokenStore(join(tmpDir, 'auth.yml'), {
      onKeychainRead: (info) => reads.push(info),
    });
    const entry = await store.get('github.com');
    expect(entry).toBeNull();
    expect(reads).toHaveLength(1);
    expect(reads[0]?.kind).toBe('corrupt-entry');
    expect(reads[0]?.host).toBe('github.com');
    expect(reads[0]?.error).toBe('corrupt-entry');
    expect(JSON.stringify(reads)).not.toContain(TOKEN_BYTES);
  });

  test('a throwing onKeychainRead callback never breaks the lookup', async () => {
    const { createTokenStore } = await import('./token-store.ts');
    const store = await createTokenStore(join(tmpDir, 'auth.yml'), {
      onKeychainRead: () => {
        throw new Error('diagnostic boom');
      },
    });
    const miss = await store.get('github.com');
    expect(miss).toBeNull();
  });

  test('a throwing onKeychainRead callback never breaks the read-error path', async () => {
    keyringMockState.throwOnGetPassword = true;
    const { createTokenStore } = await import('./token-store.ts');
    const store = await createTokenStore(join(tmpDir, 'auth.yml'), {
      onKeychainRead: () => {
        throw new Error('diagnostic boom');
      },
    });
    expect(await store.get('github.com')).toBeNull();
  });
});

describe('KeyringBackend upsert semantics', () => {
  let tmpDir: string;

  beforeEach(() => {
    resetKeyringMockState();
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-ts-upsert-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('set() invokes Entry.setPassword exactly once with a JSON payload', async () => {
    const { createTokenStore } = await import('./token-store.ts');
    const store = await createTokenStore(join(tmpDir, 'auth.yml'));
    expect(store.backend).toBe('keyring');

    await store.set('github.com', 'alice', 'gho_token_1');

    expect(keyringMockState.setPasswordCalls).toHaveLength(1);
    const [call] = keyringMockState.setPasswordCalls;
    expect(call?.service).toBe('open-knowledge');
    expect(call?.account).toBe('github.com');
    const parsed = JSON.parse(call?.value ?? '{}') as Record<string, unknown>;
    expect(parsed).toMatchObject({ login: 'alice', token: 'gho_token_1' });
  });

  test('set() never calls Entry.deletePassword on the refresh path', async () => {
    const { createTokenStore } = await import('./token-store.ts');
    const store = await createTokenStore(join(tmpDir, 'auth.yml'));
    await store.set('github.com', 'alice', 'gho_token_1');
    expect(keyringMockState.deletePasswordCalls).toHaveLength(0);
  });

  test('two set() calls (refresh) produce two setPassword calls and zero deletePassword calls', async () => {
    const { createTokenStore } = await import('./token-store.ts');
    const store = await createTokenStore(join(tmpDir, 'auth.yml'));

    await store.set('github.com', 'alice', 'gho_v1');
    await store.set('github.com', 'alice', 'gho_v2');

    expect(keyringMockState.setPasswordCalls).toHaveLength(2);
    expect(keyringMockState.deletePasswordCalls).toHaveLength(0);

    const tokens = keyringMockState.setPasswordCalls.map(
      (c) => (JSON.parse(c.value) as { token: string }).token,
    );
    expect(tokens).toEqual(['gho_v1', 'gho_v2']);
  });

  test('clear() is the only public path that calls deletePassword', async () => {
    const { createTokenStore } = await import('./token-store.ts');
    const store = await createTokenStore(join(tmpDir, 'auth.yml'));

    await store.set('github.com', 'alice', 'gho_v1');
    expect(keyringMockState.deletePasswordCalls).toHaveLength(0);

    await store.clear('github.com');
    expect(keyringMockState.deletePasswordCalls).toHaveLength(1);
    expect(keyringMockState.deletePasswordCalls[0]).toMatchObject({
      service: 'open-knowledge',
      account: 'github.com',
    });
  });
});

describe('createTokenStore fallback to FileBackend', () => {
  let tmpDir: string;
  let authFile: string;

  beforeEach(() => {
    resetKeyringMockState();
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-ts-fallback-'));
    authFile = join(tmpDir, 'auth.yml');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('falls back to FileBackend when keyring import throws', async () => {
    keyringMockState.throwOnImport = true;
    const { createTokenStore } = await import('./token-store.ts');
    const store = await createTokenStore(authFile);
    expect(store.backend).toBe('file');
  });

  test('falls back to FileBackend when Entry constructor throws', async () => {
    keyringMockState.throwOnConstruct = true;
    const { createTokenStore } = await import('./token-store.ts');
    const store = await createTokenStore(authFile);
    expect(store.backend).toBe('file');
  });

  test('FileBackend fallback persists credentials to the tmp authFile', async () => {
    keyringMockState.throwOnImport = true;
    const { createTokenStore } = await import('./token-store.ts');
    const store = await createTokenStore(authFile);

    await store.set('github.com', 'alice', 'gho_fallback');
    const entry = await store.get('github.com');
    expect(entry).toMatchObject({ login: 'alice', token: 'gho_fallback' });

    const { statSync, existsSync } = await import('node:fs');
    expect(existsSync(authFile)).toBe(true);
    if (process.platform !== 'win32') {
      const mode = statSync(authFile).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  test('FileBackend fallback round-trip works via clear()', async () => {
    keyringMockState.throwOnConstruct = true;
    const { createTokenStore } = await import('./token-store.ts');
    const store = await createTokenStore(authFile);

    await store.set('github.com', 'alice', 'gho_fallback');
    expect((await store.get('github.com'))?.token).toBe('gho_fallback');
    await store.clear('github.com');
    expect(await store.get('github.com')).toBeNull();
  });
});

describe('clearTokenFromAllBackends', () => {
  let tmpDir: string;
  let authFile: string;

  beforeEach(() => {
    resetKeyringMockState();
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-ts-clearall-'));
    authFile = join(tmpDir, 'auth.yml');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns touched:[] and creates no file when nothing is stored', async () => {
    const { clearTokenFromAllBackends } = await import('./token-store.ts');
    const result = await clearTokenFromAllBackends('github.com', authFile);
    expect(result.touched).toEqual([]);
    const { existsSync } = await import('node:fs');
    expect(existsSync(authFile)).toBe(false);
    expect(keyringMockState.deletePasswordCalls).toHaveLength(0);
  });

  test('clears file entry and reports touched:["file"]', async () => {
    const { FileBackend, clearTokenFromAllBackends } = await import('./token-store.ts');
    await new FileBackend(authFile).set('github.com', 'alice', 'gho_file_only');

    const result = await clearTokenFromAllBackends('github.com', authFile);

    expect(result.touched).toEqual(['file']);
    expect(await new FileBackend(authFile).get('github.com')).toBeNull();
    expect(keyringMockState.deletePasswordCalls).toHaveLength(0);
  });

  test('clears keychain entry and reports touched:["keychain"]', async () => {
    keyringMockState.getPasswordReturns.set(
      'open-knowledge:github.com',
      JSON.stringify({ login: 'alice', token: 'gho_keychain_only' }),
    );
    const { clearTokenFromAllBackends } = await import('./token-store.ts');

    const result = await clearTokenFromAllBackends('github.com', authFile);

    expect(result.touched).toEqual(['keychain']);
    expect(keyringMockState.deletePasswordCalls).toHaveLength(1);
    const { existsSync } = await import('node:fs');
    expect(existsSync(authFile)).toBe(false);
  });

  test('clears both backends when both hold a token', async () => {
    const { FileBackend, clearTokenFromAllBackends } = await import('./token-store.ts');
    await new FileBackend(authFile).set('github.com', 'alice', 'gho_file');
    keyringMockState.getPasswordReturns.set(
      'open-knowledge:github.com',
      JSON.stringify({ login: 'alice', token: 'gho_keychain' }),
    );

    const result = await clearTokenFromAllBackends('github.com', authFile);

    expect(result.touched.sort()).toEqual(['file', 'keychain']);
    expect(await new FileBackend(authFile).get('github.com')).toBeNull();
    expect(keyringMockState.deletePasswordCalls).toHaveLength(1);
  });

  test('clears leftover file entry when keychain probe succeeds (the leak scenario)', async () => {
    const { FileBackend, clearTokenFromAllBackends } = await import('./token-store.ts');
    await new FileBackend(authFile).set('github.com', 'alice', 'gho_stale_from_past_session');

    const result = await clearTokenFromAllBackends('github.com', authFile);

    expect(result.touched).toEqual(['file']);
    expect(await new FileBackend(authFile).get('github.com')).toBeNull();
    expect(keyringMockState.deletePasswordCalls).toHaveLength(0);
  });

  test('clears file entry when keychain native module fails to import', async () => {
    keyringMockState.throwOnImport = true;
    const { FileBackend, clearTokenFromAllBackends } = await import('./token-store.ts');
    await new FileBackend(authFile).set('github.com', 'alice', 'gho_file');

    const result = await clearTokenFromAllBackends('github.com', authFile);

    expect(result.touched).toEqual(['file']);
    expect(await new FileBackend(authFile).get('github.com')).toBeNull();
  });

  test('clears file entry when keychain Entry constructor throws', async () => {
    keyringMockState.throwOnConstruct = true;
    const { FileBackend, clearTokenFromAllBackends } = await import('./token-store.ts');
    await new FileBackend(authFile).set('github.com', 'alice', 'gho_file');

    const result = await clearTokenFromAllBackends('github.com', authFile);

    expect(result.touched).toEqual(['file']);
    expect(await new FileBackend(authFile).get('github.com')).toBeNull();
  });

  test('per-host scoping — clearing github.com leaves gitlab.com intact', async () => {
    const { FileBackend, clearTokenFromAllBackends } = await import('./token-store.ts');
    const file = new FileBackend(authFile);
    await file.set('github.com', 'alice', 'gho_gh');
    await file.set('gitlab.com', 'bob', 'glpat_gl');

    const result = await clearTokenFromAllBackends('github.com', authFile);

    expect(result.touched).toEqual(['file']);
    expect(await file.get('github.com')).toBeNull();
    expect((await file.get('gitlab.com'))?.token).toBe('glpat_gl');
  });
});

describe('createTokenStore cross-backend read fallback', () => {
  let tmpDir: string;
  let authFile: string;
  beforeEach(() => {
    resetKeyringMockState();
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-auth-fallback-'));
    authFile = join(tmpDir, 'auth.yml');
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('keychain-backed store finds a token stored only in the file backend', async () => {
    const { FileBackend, createTokenStore } = await import('./token-store.ts');
    await new FileBackend(authFile).set('github.com', 'octocat', 'gho_file', {
      gitProtocol: 'https',
    });

    const store = await createTokenStore(authFile);
    expect(store.backend).toBe('keyring');

    const entry = await store.get('github.com');
    expect(entry?.token).toBe('gho_file');
    expect(entry?.login).toBe('octocat');
  });

  test('migrates the file-stored token into the keychain and removes the plaintext copy', async () => {
    const { FileBackend, createTokenStore } = await import('./token-store.ts');
    await new FileBackend(authFile).set('github.com', 'octocat', 'gho_file', {
      gitProtocol: 'https',
      name: 'Octo Cat',
      email: 'octo@github.com',
    });

    const store = await createTokenStore(authFile);
    await store.get('github.com');

    const migrated = keyringMockState.setPasswordCalls.find(
      (c) => c.service === 'open-knowledge' && c.account === 'github.com',
    );
    expect(migrated).toBeDefined();
    const payload = JSON.parse(migrated?.value ?? '{}') as { token?: string; email?: string };
    expect(payload.token).toBe('gho_file');
    expect(payload.email).toBe('octo@github.com');

    expect(await new FileBackend(authFile).get('github.com')).toBeNull();
  });

  test('keychain hit short-circuits — no file read, no migration', async () => {
    const { createTokenStore } = await import('./token-store.ts');
    keyringMockState.getPasswordReturns.set(
      'open-knowledge:github.com',
      JSON.stringify({ login: 'octocat', token: 'gho_keychain', gitProtocol: 'https' }),
    );

    const store = await createTokenStore(authFile);
    const entry = await store.get('github.com');

    expect(entry?.token).toBe('gho_keychain');
    expect(keyringMockState.setPasswordCalls).toHaveLength(0);
  });

  test('returns null when neither backend has the host', async () => {
    const { createTokenStore } = await import('./token-store.ts');
    const store = await createTokenStore(authFile);
    expect(await store.get('github.com')).toBeNull();
  });
});
