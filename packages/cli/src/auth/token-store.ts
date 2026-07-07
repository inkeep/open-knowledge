import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

/** Stored credential entry keyed by hostname. */
interface TokenEntry {
  login: string;
  token: string;
  /** Default git protocol for this host (default 'https') */
  gitProtocol?: string;
  /** User display name from OAuth profile, for identity resolution */
  name?: string;
  /** User email from OAuth profile, for identity resolution */
  email?: string;
}

/** Unified token storage API. Both backends implement this interface. */
export interface TokenStore {
  /** Which storage mechanism is active */
  readonly backend: 'keyring' | 'file';
  get(host: string): Promise<TokenEntry | null>;
  set(
    host: string,
    login: string,
    token: string,
    extra?: Pick<TokenEntry, 'gitProtocol' | 'name' | 'email'>,
  ): Promise<void>;
  clear(host: string): Promise<void>;
}

const KEYRING_SERVICE = 'open-knowledge';

/**
 * Run a diagnostic callback so a throwing observer can never break the
 * credential lookup it observes. Diagnostics are best-effort instrumentation;
 * an exception in one must not abort `get()` / `createTokenStore` and strand
 * the user without a credential.
 */
function safeDiag(fn: () => void): void {
  try {
    fn();
  } catch {
    // Diagnostic must never break the lookup.
  }
}

/**
 * Optional observability hooks for the token store. Kept as plain callbacks so
 * `token-store` stays logger-agnostic (it's also constructed in the server
 * push-permission probe path); the credential helper wires these to its file
 * logger. A keychain read that returns nothing reports `absent`
 * (errSecItemNotFound); a read that throws — locked keychain, ACL/access
 * denied, native ABI mismatch — reports `read-error`. A stored entry that
 * fails to JSON-parse reports `corrupt-entry`. The kinds are indistinguishable
 * from the returned `null` alone, which is exactly the signal lost when a
 * credential silently disappears.
 *
 * `error` only ever carries a bounded, value-free token: an `Error.name`
 * (e.g. `SyntaxError`) or a fixed string. Never a full error message — a
 * parse/keychain error message can echo bytes of the stored credential.
 */
export interface TokenStoreDiagnostics {
  onKeychainRead?: (info: {
    kind: 'absent' | 'read-error' | 'corrupt-entry';
    host: string;
    error?: string;
  }) => void;
  onBackendSelected?: (info: { backend: 'keyring' | 'file'; reason?: string }) => void;
}

// ---------------------------------------------------------------------------
// Keyring backend
// ---------------------------------------------------------------------------

class KeyringBackend implements TokenStore {
  readonly backend = 'keyring' as const;

  constructor(private readonly onKeychainRead?: TokenStoreDiagnostics['onKeychainRead']) {}

  async get(host: string): Promise<TokenEntry | null> {
    const { Entry } = await import('@napi-rs/keyring');
    let raw: string | null;
    try {
      // A throw here is a genuine keychain access failure (locked / ACL-denied
      // / ABI mismatch). Report only `e.name` — never the full message — so no
      // stored bytes can leak through a native error string into the log.
      raw = new Entry(KEYRING_SERVICE, host).getPassword();
    } catch (e) {
      safeDiag(() =>
        this.onKeychainRead?.({
          kind: 'read-error',
          host,
          error: e instanceof Error ? e.name : 'unknown',
        }),
      );
      return null;
    }

    if (raw == null) {
      safeDiag(() => this.onKeychainRead?.({ kind: 'absent', host }));
      return null;
    }

    try {
      return JSON.parse(raw) as TokenEntry;
    } catch {
      // A corrupted entry is distinct from a keychain access failure. Crucially,
      // a JSON.parse SyntaxError message echoes ~20 chars of `raw` (token
      // bytes); never surface it. Emit a fixed marker with no bytes and treat
      // the entry as unreadable.
      safeDiag(() =>
        this.onKeychainRead?.({ kind: 'corrupt-entry', host, error: 'corrupt-entry' }),
      );
      return null;
    }
  }

  async set(
    host: string,
    login: string,
    token: string,
    extra?: Pick<TokenEntry, 'gitProtocol' | 'name' | 'email'>,
  ): Promise<void> {
    const { Entry } = await import('@napi-rs/keyring');
    const entry = new Entry(KEYRING_SERVICE, host);
    const data: TokenEntry = { login, token, ...extra };
    entry.setPassword(JSON.stringify(data));
  }

  async clear(host: string): Promise<void> {
    const { Entry } = await import('@napi-rs/keyring');
    try {
      const entry = new Entry(KEYRING_SERVICE, host);
      entry.deletePassword();
    } catch {
      // Already absent — ignore
    }
  }
}

// ---------------------------------------------------------------------------
// File backend (~/.ok/auth.yml, chmod 0600)
// ---------------------------------------------------------------------------

export class FileBackend implements TokenStore {
  readonly backend = 'file' as const;
  private readonly authFile: string;

  constructor(authFile?: string) {
    this.authFile = authFile ?? join(homedir(), '.ok', 'auth.yml');
  }

  private read(): Record<string, TokenEntry> {
    if (!existsSync(this.authFile)) return {};
    try {
      const raw = readFileSync(this.authFile, 'utf-8');
      return (yamlParse(raw) ?? {}) as Record<string, TokenEntry>;
    } catch (e) {
      // Silent failure here would let the next `write()` overwrite a corrupted
      // but recoverable auth.yml with `{}`, quietly wiping valid tokens. Surface
      // the parse error so users can repair the file before re-authenticating.
      const msg = e instanceof Error ? e.message : 'unknown error';
      process.stderr.write(
        `[auth] Failed to parse ${this.authFile}: ${msg}. Starting with empty credentials.\n`,
      );
      return {};
    }
  }

  private write(data: Record<string, TokenEntry>): void {
    const dir = dirname(this.authFile);
    // 0o700 keeps the directory unreadable by other local users — matches the
    // 0o600 file mode below and prevents listing "you have OpenKnowledge
    // credentials" from a shared-host account.
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.authFile, yamlStringify(data), { mode: 0o600 });
  }

  async get(host: string): Promise<TokenEntry | null> {
    return this.read()[host] ?? null;
  }

  async set(
    host: string,
    login: string,
    token: string,
    extra?: Pick<TokenEntry, 'gitProtocol' | 'name' | 'email'>,
  ): Promise<void> {
    const data = this.read();
    data[host] = { login, token, ...extra };
    this.write(data);
  }

  async clear(host: string): Promise<void> {
    const data = this.read();
    delete data[host];
    this.write(data);
  }
}

// ---------------------------------------------------------------------------
// Keychain store with file-backend read fallback + migration
// ---------------------------------------------------------------------------

/**
 * Wraps the keychain backend so a token written only to the file backend — by
 * an older or mis-packaged build whose keyring couldn't load — is still found,
 * then migrated into the keychain and removed from the plaintext file.
 *
 * Reads fall back keychain → file; writes and clears target the keychain (the
 * preferred backend). `clear()` also removes any orphaned plaintext copy, but
 * only when present, matching `clearTokenFromAllBackends`'
 * don't-leave-an-empty-auth.yml discipline.
 */
class KeychainWithFileFallback implements TokenStore {
  readonly backend = 'keyring' as const;
  constructor(
    private readonly keychain: TokenStore,
    private readonly file: FileBackend,
  ) {}

  async get(host: string): Promise<TokenEntry | null> {
    const fromKeychain = await this.keychain.get(host);
    if (fromKeychain != null) return fromKeychain;

    const fromFile = await this.file.get(host);
    if (fromFile == null) return null;

    // Migrate the orphaned plaintext token into the keychain, then drop the
    // plaintext copy. Best-effort: if the keychain write fails, keep the file
    // token and return it — losing the credential is worse than a delayed
    // migration (the next get() retries).
    try {
      await this.keychain.set(host, fromFile.login, fromFile.token, {
        gitProtocol: fromFile.gitProtocol,
        name: fromFile.name,
        email: fromFile.email,
      });
      await this.file.clear(host);
      process.stderr.write(
        `[auth] migrated ${host} credential from ~/.ok/auth.yml to the OS keychain\n`,
      );
    } catch {
      // Keep the file token; a later get() retries the migration.
    }
    return fromFile;
  }

  set(
    host: string,
    login: string,
    token: string,
    extra?: Pick<TokenEntry, 'gitProtocol' | 'name' | 'email'>,
  ): Promise<void> {
    return this.keychain.set(host, login, token, extra);
  }

  async clear(host: string): Promise<void> {
    await this.keychain.clear(host);
    if ((await this.file.get(host)) != null) await this.file.clear(host);
  }
}

// ---------------------------------------------------------------------------
// Factory — auto-detect backend
// ---------------------------------------------------------------------------

/**
 * Create a TokenStore, preferring the OS keychain (via @napi-rs/keyring) and
 * falling back to a plaintext YAML file at ~/.ok/auth.yml when the
 * native module cannot be loaded.
 *
 * Logs the active backend at INFO level once.
 */
export async function createTokenStore(
  authFile?: string,
  diag?: TokenStoreDiagnostics,
): Promise<TokenStore> {
  try {
    const { Entry } = await import('@napi-rs/keyring');
    // Verify the native module loaded and Entry is usable
    new Entry(KEYRING_SERVICE, '__probe__');
    process.stderr.write('[auth] token storage: OS keychain\n');
    safeDiag(() => diag?.onBackendSelected?.({ backend: 'keyring' }));
    // Wrap so a token stranded in the plaintext file backend (written by a
    // build whose keyring couldn't load) is still found and migrated in.
    return new KeychainWithFileFallback(
      new KeyringBackend(diag?.onKeychainRead),
      new FileBackend(authFile),
    );
  } catch (e) {
    // A keyring LOAD failure must never silently downgrade to plaintext
    // storage without a trace. Surface WHY — e.g. ERR_MODULE_NOT_FOUND from a
    // mis-packaged bundle, native ABI mismatch, or keychain entitlement
    // refusal — so the file fallback is auditable rather than invisible.
    const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    process.stderr.write(
      `[auth] token storage: file (~/.ok/auth.yml) — OS keychain unavailable: ${reason}\n`,
    );
    safeDiag(() => diag?.onBackendSelected?.({ backend: 'file', reason }));
    return new FileBackend(authFile);
  }
}

/**
 * Shared lazy-init engine used by both `makeLazyProbeTokenStore` and
 * `makeLazyTokenStore`. Defers the underlying `createTokenStore()` call to
 * the first method invocation AND time-boxes it at 2s with a `FileBackend`
 * fallback. Caches the resolved store so subsequent calls are immediate.
 *
 * The `@napi-rs/keyring` native binding can hang on first load — macOS
 * Keychain first-access prompts and cold native binding loads both manifest
 * as an unresolved promise. Without this wrapper, an `await createTokenStore()`
 * on a boot or cold-start path blocks the calling process indefinitely,
 * which beachballs the Electron app.
 */
function lazyResolveTokenStore(authFile: string | undefined): () => Promise<TokenStore> {
  let cached: Promise<TokenStore> | null = null;
  return function resolve(): Promise<TokenStore> {
    if (cached) return cached;
    const TIMEOUT_MS = 2000;
    cached = (async () => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<TokenStore>((res) => {
        timer = setTimeout(() => {
          process.stderr.write(
            `[auth] token storage: keyring init exceeded ${TIMEOUT_MS}ms; falling back to file (~/.ok/auth.yml)\n`,
          );
          res(new FileBackend(authFile));
        }, TIMEOUT_MS);
      });
      try {
        return await Promise.race([createTokenStore(authFile), timeout]);
      } catch {
        // `createTokenStore` itself catches keyring failures and falls back
        // to FileBackend, so this catch fires only on an unexpected throw
        // (OOM, corrupted binding load, etc.). Without it, a rejected
        // promise would be permanently stored in `cached` and every
        // subsequent `.get()` call would re-throw — silently breaking the
        // token-store tier for the entire session. Mirror the timeout
        // path's FileBackend fallback so the probe still resolves stored
        // OK tokens.
        return new FileBackend(authFile);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    })();
    return cached;
  };
}

/**
 * Push-permission-probe-shaped token store. Returns immediately; defers
 * the underlying `createTokenStore()` to the first `.get()` call.
 * Structural shape matches the server's `ProbeTokenStore` interface.
 */
export function makeLazyProbeTokenStore(authFile?: string): {
  get: (host: string) => Promise<{ token?: string } | null>;
} {
  const resolve = lazyResolveTokenStore(authFile);
  return {
    async get(host: string) {
      const store = await resolve();
      const entry = await store.get(host);
      return entry === null ? null : { token: entry.token };
    },
  };
}

/**
 * Full `TokenStore`-shaped lazy wrapper. Use this where the consumer
 * expects the full `TokenStore` interface (get / set / clear) but you
 * want the cold-start `createTokenStore()` call deferred — most
 * importantly the `ok clone` hot path, where users with `gh` installed
 * never reach the `.get()` call at all (resolveAuth early-returns on
 * Tier A) so the keyring init can be skipped entirely.
 *
 * Pre-resolution the `backend` field reports `'file'` — a placeholder.
 * Read-only consumers (resolveAuth via `.get`) don't care; consumers
 * that branch on `backend` should await `resolve()` first.
 */
export function makeLazyTokenStore(authFile?: string): TokenStore {
  const resolve = lazyResolveTokenStore(authFile);
  return {
    backend: 'file' as const,
    async get(host) {
      const store = await resolve();
      return store.get(host);
    },
    async set(host, login, token, extra) {
      const store = await resolve();
      return store.set(host, login, token, extra);
    },
    async clear(host) {
      const store = await resolve();
      return store.clear(host);
    },
  };
}

/**
 * Defensive signout — clear `host` credentials from every backend we know
 * about (keychain + file), regardless of which one `createTokenStore` resolves
 * today. Necessary because the resolved backend can flip between runs (when
 * the `@napi-rs/keyring` native binding fails to load in one process but
 * succeeds in another), leaving stale tokens in the un-probed backend if
 * `signout` only cleared the resolved one.
 *
 * Returns which backends actually had a stored entry and were cleared. The
 * caller composes user-facing messaging from this.
 *
 * Side-effect discipline: only writes to a backend that already had an entry
 * for `host`. A keychain-only user signing out does not gain an empty
 * `~/.ok/auth.yml` as a side effect. Keyring access is skipped silently when
 * the native binding can't load.
 */
export async function clearTokenFromAllBackends(
  host: string,
  authFile?: string,
): Promise<{ touched: Array<'keychain' | 'file'>; keychainError?: string }> {
  const touched: Array<'keychain' | 'file'> = [];

  const file = new FileBackend(authFile);
  if ((await file.get(host)) != null) {
    await file.clear(host);
    touched.push('file');
  }

  // `keychainError` is set ONLY when the keyring binding LOADS but a read
  // errors (a locked / ACL-denied keychain): we then can't confirm or complete
  // removal. It lets `ok uninstall` mark the keychain item unresolved and print
  // a manual-removal hint rather than falsely reporting a clean removal.
  // `KeyringBackend.get` swallows the read error and returns null, so a
  // diagnostics hook is the only way to observe it.
  let keychainError: string | undefined;
  try {
    const { Entry } = await import('@napi-rs/keyring');
    new Entry(KEYRING_SERVICE, '__probe__');
    let readError: string | undefined;
    const keyring = new KeyringBackend((info) => {
      if (info.kind === 'read-error') readError = info.error ?? 'read-error';
    });
    const existing = await keyring.get(host);
    if (readError !== undefined) {
      keychainError = readError;
    } else if (existing != null) {
      // Delete directly (not via `KeyringBackend.clear`, which swallows ALL
      // errors for the migrating store's idempotent signout). `deletePassword()`
      // returns `false` for the benign already-absent case and THROWS only on a
      // real failure (locked / ACL-denied) — surface that as `keychainError` so
      // uninstall reports the credential un-removed rather than falsely cleared.
      try {
        new Entry(KEYRING_SERVICE, host).deletePassword();
        touched.push('keychain');
      } catch (e) {
        keychainError = e instanceof Error ? e.name : 'delete-error';
      }
    }
  } catch {
    // Native binding unavailable on this run — OK could never have stored a
    // keychain token on this machine (set() needs the binding too), so there is
    // nothing to remove and nothing to report. Intentionally NOT an error.
  }

  return { touched, keychainError };
}
