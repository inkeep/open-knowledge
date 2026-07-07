import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mutable mock state shared with the mocked `@napi-rs/keyring`. Each test
// resets this via `resetKeyringMockState()` in beforeEach. The mock's `Entry`
// export is a getter so we can simulate both failure branches of
// `createTokenStore`'s probe: module-evaluation failure (throwOnImport) and
// constructor failure (throwOnConstruct).
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
  // Simulate a keychain read that fails (locked keychain / ACL denial / ABI
  // mismatch) — `getPassword()` throws rather than returning null. Drives the
  // `read-error` vs `absent` diagnostic distinction.
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

mock.module('@napi-rs/keyring', () => ({ Entry: MockKeyringEntry }));

import { FileBackend } from './token-store.ts';

// ---------------------------------------------------------------------------
// File backend — tested directly with a tmp directory
// ---------------------------------------------------------------------------

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
    // The file should exist
    expect(await stat.exists()).toBe(true);
    // Verify mode via Node fs stat
    const { statSync } = await import('node:fs');
    const mode = statSync(authFile).mode & 0o777;
    // 0600 on Unix; Windows may return different value
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o600);
    }
  });

  test('file contents are valid YAML with hostname keys', async () => {
    await store.set('github.com', 'alice', 'gho_abc123');
    await store.set('gitlab.com', 'bob', 'glpat_xyz');
    const raw = readFileSync(authFile, 'utf-8');
    // Should contain both hostnames as YAML keys
    expect(raw).toContain('github.com');
    expect(raw).toContain('gitlab.com');
    // Token values present
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

// ---------------------------------------------------------------------------
// createTokenStore — integration smoke test
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// TokenStoreDiagnostics — keychain read outcome + backend selection
//
// These hooks are the only signal that distinguishes a genuinely-absent
// credential (errSecItemNotFound → null) from a keychain read that failed
// (locked / ACL-denied / ABI mismatch → throw). Both return null to callers,
// so without the diagnostic the cause of a vanished credential is unknowable.
// ---------------------------------------------------------------------------

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
    // Behaviour preserved: a failed read still resolves to null for callers.
    expect(entry).toBeNull();
    expect(reads).toHaveLength(1);
    expect(reads[0]?.kind).toBe('read-error');
    expect(reads[0]?.host).toBe('github.com');
    // Only the error NAME is surfaced (e.g. 'Error'), never the message — a
    // native keychain error string could echo stored credential bytes.
    expect(reads[0]?.error).toBe('Error');
    // The mock throws `new Error('keychain read denied')`; the message must not
    // reach the diagnostic.
    expect(JSON.stringify(reads)).not.toContain('keychain read denied');
  });

  test('onKeychainRead reports corrupt-entry (no stored bytes) when JSON.parse fails', async () => {
    // A non-JSON value masquerading as a stored token. Its bytes must never
    // appear in the emitted diagnostic — a JSON.parse SyntaxError message would
    // echo ~20 chars of the raw value otherwise.
    const TOKEN_BYTES = 'gho_corrupt_secret_value_xyz';
    keyringMockState.getPasswordReturns.set(`open-knowledge:github.com`, TOKEN_BYTES);
    const { createTokenStore } = await import('./token-store.ts');
    const reads: Array<{ kind: string; host: string; error?: string }> = [];
    const store = await createTokenStore(join(tmpDir, 'auth.yml'), {
      onKeychainRead: (info) => reads.push(info),
    });
    const entry = await store.get('github.com');
    // Behaviour preserved: an unparseable entry still resolves to null.
    expect(entry).toBeNull();
    expect(reads).toHaveLength(1);
    // Distinct from a genuine keychain access failure.
    expect(reads[0]?.kind).toBe('corrupt-entry');
    expect(reads[0]?.host).toBe('github.com');
    // Fixed marker, no bytes.
    expect(reads[0]?.error).toBe('corrupt-entry');
    // The token bytes must not leak across the full serialized diagnostic.
    expect(JSON.stringify(reads)).not.toContain(TOKEN_BYTES);
  });

  test('a throwing onKeychainRead callback never breaks the lookup', async () => {
    // Diagnostics are best-effort; an exception in the observer must not abort
    // get() or strand the caller. Exercised on the absent path (the only path
    // that emits onKeychainRead when nothing is stored).
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

// ---------------------------------------------------------------------------
// KeyringBackend upsert semantics
//
// Reachability-tested via `createTokenStore` + mock.module rather than
// importing KeyringBackend directly, to avoid widening token-store.ts's
// public surface.
//
// Negative control (documented, not implemented): a broken `set()` impl that
// replaced `entry.setPassword(...)` with `entry.deletePassword(); entry.setPassword(...)`
// would fail the "never calls deletePassword during refresh" assertion below.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// createTokenStore fallback to FileBackend
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// clearTokenFromAllBackends — defensive signout
//
// Guarantees signout clears credentials from every backend regardless of
// which one createTokenStore resolves today. The load-bearing leak scenario:
// the keyring native binding fails to load on session A (token writes go to
// ~/.ok/auth.yml) but loads on session B (signout clears the empty keychain
// and leaves auth.yml untouched). The defensive helper closes that gap.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// createTokenStore cross-backend read fallback + migration
//
// Regression guard for the silent-plaintext / split-brain bug: when the
// bundled desktop CLI could not resolve `@napi-rs/keyring`, auth tokens were
// written to the plaintext file backend (~/.ok/auth.yml). A later run whose
// keyring DID load resolved the keychain backend, read an empty keychain, and
// reported the user logged out — the file-stored token was invisible. The
// keychain-backed store now falls back to the file backend on a miss and
// migrates the orphaned token into the keychain.
// ---------------------------------------------------------------------------

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
    // Simulate the bug: a credential written only to the plaintext file.
    const { FileBackend, createTokenStore } = await import('./token-store.ts');
    await new FileBackend(authFile).set('github.com', 'octocat', 'gho_file', {
      gitProtocol: 'https',
    });

    // Keyring resolves (mock available) → keychain backend, keychain empty.
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

    // Migrated into the keychain (service 'open-knowledge', account host) ...
    const migrated = keyringMockState.setPasswordCalls.find(
      (c) => c.service === 'open-knowledge' && c.account === 'github.com',
    );
    expect(migrated).toBeDefined();
    const payload = JSON.parse(migrated?.value ?? '{}') as { token?: string; email?: string };
    expect(payload.token).toBe('gho_file');
    expect(payload.email).toBe('octo@github.com');

    // ... and the plaintext copy removed.
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
    // No migration write — the keychain already had it.
    expect(keyringMockState.setPasswordCalls).toHaveLength(0);
  });

  test('returns null when neither backend has the host', async () => {
    const { createTokenStore } = await import('./token-store.ts');
    const store = await createTokenStore(authFile);
    expect(await store.get('github.com')).toBeNull();
  });
});
