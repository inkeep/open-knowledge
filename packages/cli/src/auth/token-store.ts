import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';

interface TokenEntry {
  login: string;
  token: string;
  gitProtocol?: string;
  name?: string;
  email?: string;
}

export interface TokenStore {
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

function safeDiag(fn: () => void): void {
  try {
    fn();
  } catch {
  }
}

export interface TokenStoreDiagnostics {
  onKeychainRead?: (info: {
    kind: 'absent' | 'read-error' | 'corrupt-entry';
    host: string;
    error?: string;
  }) => void;
  onBackendSelected?: (info: { backend: 'keyring' | 'file'; reason?: string }) => void;
}


class KeyringBackend implements TokenStore {
  readonly backend = 'keyring' as const;

  constructor(private readonly onKeychainRead?: TokenStoreDiagnostics['onKeychainRead']) {}

  async get(host: string): Promise<TokenEntry | null> {
    const { Entry } = await import('@napi-rs/keyring');
    let raw: string | null;
    try {
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
    }
  }
}


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
      const msg = e instanceof Error ? e.message : 'unknown error';
      process.stderr.write(
        `[auth] Failed to parse ${this.authFile}: ${msg}. Starting with empty credentials.\n`,
      );
      return {};
    }
  }

  private write(data: Record<string, TokenEntry>): void {
    const dir = dirname(this.authFile);
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


export async function createTokenStore(
  authFile?: string,
  diag?: TokenStoreDiagnostics,
): Promise<TokenStore> {
  try {
    const { Entry } = await import('@napi-rs/keyring');
    new Entry(KEYRING_SERVICE, '__probe__');
    process.stderr.write('[auth] token storage: OS keychain\n');
    safeDiag(() => diag?.onBackendSelected?.({ backend: 'keyring' }));
    return new KeychainWithFileFallback(
      new KeyringBackend(diag?.onKeychainRead),
      new FileBackend(authFile),
    );
  } catch (e) {
    const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    process.stderr.write(
      `[auth] token storage: file (~/.ok/auth.yml) — OS keychain unavailable: ${reason}\n`,
    );
    safeDiag(() => diag?.onBackendSelected?.({ backend: 'file', reason }));
    return new FileBackend(authFile);
  }
}

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
        return new FileBackend(authFile);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    })();
    return cached;
  };
}

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

export async function clearTokenFromAllBackends(
  host: string,
  authFile?: string,
): Promise<{ touched: Array<'keychain' | 'file'> }> {
  const touched: Array<'keychain' | 'file'> = [];

  const file = new FileBackend(authFile);
  if ((await file.get(host)) != null) {
    await file.clear(host);
    touched.push('file');
  }

  try {
    const { Entry } = await import('@napi-rs/keyring');
    new Entry(KEYRING_SERVICE, '__probe__');
    const keyring = new KeyringBackend();
    if ((await keyring.get(host)) != null) {
      await keyring.clear(host);
      touched.push('keychain');
    }
  } catch {
  }

  return { touched };
}
