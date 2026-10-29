import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  currentDesktopProduct,
  DEFAULT_EMBEDDINGS_BASE_URL,
  OK_USER_HOME_SECRETS_FILE,
} from '@inkeep/open-knowledge-core';
import { okUserHomeDir } from '@inkeep/open-knowledge-core/server';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import {
  tracedMkdirSync,
  tracedRenameSync,
  tracedUnlinkSync,
  tracedWriteFileSync,
} from '../fs-traced.ts';
import { sleepSyncMs } from '../sleep-sync.ts';
import { EmbeddingsSecretStoreError } from './credential-errors.ts';
import { normalizeProviderId } from './embedder.ts';
import {
  createKeychainEmbeddingsStore,
  type EmbeddingsNativeStore,
  withEmbeddingsLock,
} from './keychain-embeddings-store.ts';

const DEFAULT_ENDPOINT_ID = normalizeProviderId(DEFAULT_EMBEDDINGS_BASE_URL);

const SECRETS_KEY_FIELD = 'OPENAI_API_KEY';

const LEGACY_KEY_FIELD = 'embeddings';

const PROJECTS_FIELD = 'embeddings_projects';
type ProjectsMap = Record<string, Record<string, string>>;

export { EmbeddingsSecretStoreError } from './credential-errors.ts';

export const EMBEDDINGS_STORE_TIMEOUT_MS = 2000;

export function isUnavailableLinuxKeyring(error: unknown, platform: NodeJS.Platform): boolean {
  if (platform !== 'linux' || !(error instanceof Error) || error.name !== 'Error') return false;
  if ((error as Error & { code?: unknown }).code !== 'GenericFailure') return false;
  return (
    error.message ===
      'Platform failure: DBus error: Using X11 for dbus-daemon autolaunch was disabled at compile time, set your DBUS_SESSION_BUS_ADDRESS instead' ||
    error.message ===
      'Platform failure: DBus error: The name org.freedesktop.secrets was not provided by any .service files'
  );
}

export type EmbeddingsKeySource = 'project' | 'file' | 'env' | null;

export interface ResolvedEmbeddingsKey {
  key: string | null;
  source: EmbeddingsKeySource;
}

export function canonicalProjectKey(projectDir: string): string {
  try {
    return realpathSync.native(projectDir);
  } catch {
    return resolve(projectDir);
  }
}

export function secretsFilePath(homedirOverride?: string): string {
  return join(okUserHomeDir(homedirOverride ?? homedir()), OK_USER_HOME_SECRETS_FILE);
}

export interface EmbeddingsKeyPresence {
  present: boolean;
  hint: string | null;
  source: EmbeddingsKeySource;
}

export interface EmbeddingsProjectListing {
  projectKey: string;
  endpoints: Array<{ endpoint: string; hint: string | null }>;
}

export interface EmbeddingsKeyReader {
  resolveForProject(projectDir: string, baseUrl: string): Promise<ResolvedEmbeddingsKey>;
  describeForProject(projectDir: string, baseUrl: string): Promise<EmbeddingsKeyPresence>;
  getLegacyKey(): Promise<string | null>;
}

export interface EmbeddingsSecretStore extends EmbeddingsKeyReader {
  readonly backend: 'file' | 'keyring';
  setForProject(projectDir: string, baseUrl: string, key: string): Promise<void>;
  clearForProject(projectDir: string, baseUrl: string): Promise<boolean>;
  clearAllForProject(projectDir: string): Promise<boolean>;
  listProjects(): Promise<EmbeddingsProjectListing[]>;
  clearAll(): Promise<{ touched: Array<'file' | 'keychain'> }>;
}

export interface EmbeddingsMigrationStore extends EmbeddingsSecretStore {
  migrateStoredProject(projectKey: string, endpoint: string): Promise<boolean>;
}

function keyHint(key: string | null): string | null {
  return key && key.length >= 8 ? key.slice(-4) : null;
}

const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 10_000;

export class FileEmbeddingsBackend implements EmbeddingsMigrationStore {
  readonly backend = 'file' as const;
  private readonly secretsFile: string;

  constructor(secretsFile?: string) {
    this.secretsFile = secretsFile ?? secretsFilePath();
  }

  private withLock<T>(fn: () => T): T {
    const lockPath = `${this.secretsFile}.lock`;
    const dir = dirname(this.secretsFile);
    if (!existsSync(dir)) tracedMkdirSync(dir, { recursive: true, mode: 0o700 });
    const start = Date.now();
    let held = false;
    while (!held) {
      try {
        const fd = openSync(lockPath, 'wx', 0o600);
        writeSync(fd, String(process.pid));
        closeSync(fd);
        held = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          const msg = err instanceof Error ? err.message : 'unknown error';
          process.stderr.write(
            `[embeddings] could not acquire the secrets write-lock (${msg}); ` +
              `proceeding without cross-process serialization.\n`,
          );
          break;
        }
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() - start > LOCK_TIMEOUT_MS) break;
        sleepSyncMs(15);
      }
    }
    try {
      return fn();
    } finally {
      if (held) {
        try {
          unlinkSync(lockPath);
        } catch {}
      }
    }
  }

  private tightenPermsIfLoose(strict = false): void {
    let mode: number;
    try {
      mode = statSync(this.secretsFile).mode & 0o777;
    } catch (error) {
      if (strict) throw new EmbeddingsSecretStoreError('file_access', 'file_read', error);
      return;
    }
    if (strict ? mode === 0o600 : (mode & 0o077) === 0) return;
    try {
      chmodSync(this.secretsFile, 0o600);
      process.stderr.write(
        `[embeddings] ${this.secretsFile} was readable beyond your user account ` +
          `(mode ${mode.toString(8)}); tightened to 600. It stores an API key.\n`,
      );
    } catch (e) {
      if (strict) throw new EmbeddingsSecretStoreError('file_access', 'file_read', e);
      const msg = e instanceof Error ? e.message : 'unknown error';
      process.stderr.write(
        `[embeddings] ${this.secretsFile} is readable beyond your user account ` +
          `(mode ${mode.toString(8)}) and could not be tightened (${msg}); your API key ` +
          `remains exposed — run: chmod 600 ${this.secretsFile}\n`,
      );
    }
  }

  read(strict = false): Record<string, unknown> {
    if (!existsSync(this.secretsFile)) return {};
    this.tightenPermsIfLoose(strict);
    try {
      const parsed: unknown = yamlParse(readFileSync(this.secretsFile, 'utf-8')) ?? {};
      if (strict && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
        throw new Error('Invalid embeddings secrets');
      }
      return parsed as Record<string, unknown>;
    } catch (e) {
      if (strict) throw new EmbeddingsSecretStoreError('file_access', 'file_read', e);
      const msg = e instanceof Error ? e.message : 'unknown error';
      process.stderr.write(
        `[embeddings] Failed to parse ${this.secretsFile}: ${msg}. Starting with empty secrets.\n`,
      );
      return {};
    }
  }

  private write(data: Record<string, unknown>): void {
    const dir = dirname(this.secretsFile);
    if (!existsSync(dir)) tracedMkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.secretsFile}.tmp`;
    tracedWriteFileSync(tmp, yamlStringify(data), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    tracedRenameSync(tmp, this.secretsFile);
    chmodSync(this.secretsFile, 0o600);
  }

  writeOrUnlink(data: Record<string, unknown>, strict = false): void {
    if (Object.keys(data).length === 0) {
      try {
        tracedUnlinkSync(this.secretsFile);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          if (strict) throw err;
          const msg = err instanceof Error ? err.message : 'unknown error';
          process.stderr.write(
            `[embeddings] could not remove ${this.secretsFile} (${msg}); a cleared key may ` +
              `remain on disk — delete the file manually if needed.\n`,
          );
        }
      }
      return;
    }
    this.write(data);
  }

  private readProjects(data: Record<string, unknown>): ProjectsMap {
    const raw = data[PROJECTS_FIELD];
    return raw && typeof raw === 'object' ? (raw as ProjectsMap) : {};
  }

  private legacyKey(data: Record<string, unknown>): string | null {
    const value = data[SECRETS_KEY_FIELD] ?? data[LEGACY_KEY_FIELD];
    return typeof value === 'string' && value !== '' ? value : null;
  }

  resolveForProject(projectDir: string, baseUrl: string): Promise<ResolvedEmbeddingsKey> {
    const data = this.read();
    const endpoint = normalizeProviderId(baseUrl);
    const slot = this.readProjects(data)[canonicalProjectKey(projectDir)]?.[endpoint];
    if (typeof slot === 'string' && slot !== '') {
      return Promise.resolve({ key: slot, source: 'project' });
    }
    if (endpoint === DEFAULT_ENDPOINT_ID) {
      const legacy = this.legacyKey(data);
      if (legacy) return Promise.resolve({ key: legacy, source: 'file' });
    }
    return Promise.resolve({ key: null, source: null });
  }

  describeForProject(projectDir: string, baseUrl: string): Promise<EmbeddingsKeyPresence> {
    return this.resolveForProject(projectDir, baseUrl).then(({ key, source }) => ({
      present: key !== null,
      hint: keyHint(key),
      source,
    }));
  }

  getLegacyKey(): Promise<string | null> {
    return Promise.resolve(this.legacyKey(this.read()));
  }

  setForProject(projectDir: string, baseUrl: string, key: string): Promise<void> {
    this.withLock(() => {
      const data = this.read();
      const projects = this.readProjects(data);
      const pkey = canonicalProjectKey(projectDir);
      projects[pkey] = { ...projects[pkey], [normalizeProviderId(baseUrl)]: key };
      data[PROJECTS_FIELD] = projects;
      this.write(data);
    });
    return Promise.resolve();
  }

  clearForProject(projectDir: string, baseUrl: string): Promise<boolean> {
    const existed = this.withLock(() => {
      const data = this.read();
      const projects = this.readProjects(data);
      const pkey = canonicalProjectKey(projectDir);
      const endpoint = normalizeProviderId(baseUrl);
      if (projects[pkey]?.[endpoint] === undefined) return false;
      delete projects[pkey][endpoint];
      if (Object.keys(projects[pkey]).length === 0) delete projects[pkey];
      if (Object.keys(projects).length === 0) delete data[PROJECTS_FIELD];
      else data[PROJECTS_FIELD] = projects;
      this.writeOrUnlink(data, true);
      return true;
    });
    return Promise.resolve(existed);
  }

  clearAllForProject(projectDir: string): Promise<boolean> {
    const existed = this.withLock(() => {
      const data = this.read();
      const projects = this.readProjects(data);
      const pkey = canonicalProjectKey(projectDir);
      if (projects[pkey] === undefined) return false;
      delete projects[pkey];
      if (Object.keys(projects).length === 0) delete data[PROJECTS_FIELD];
      else data[PROJECTS_FIELD] = projects;
      this.writeOrUnlink(data, true);
      return true;
    });
    return Promise.resolve(existed);
  }

  clearAll(): Promise<{ touched: Array<'file'> }> {
    const touched = this.withLock(() => {
      const data = this.read();
      const had =
        data[PROJECTS_FIELD] !== undefined ||
        data[SECRETS_KEY_FIELD] !== undefined ||
        data[LEGACY_KEY_FIELD] !== undefined;
      delete data[PROJECTS_FIELD];
      delete data[SECRETS_KEY_FIELD];
      delete data[LEGACY_KEY_FIELD];
      if (had) this.writeOrUnlink(data, true);
      return had;
    });
    return Promise.resolve(touched ? { touched: ['file'] as Array<'file'> } : { touched: [] });
  }

  listProjects(): Promise<EmbeddingsProjectListing[]> {
    const projects = this.readProjects(this.read());
    const listing = Object.entries(projects).map(([projectKey, endpoints]) => ({
      projectKey,
      endpoints: Object.entries(endpoints).map(([endpoint, key]) => ({
        endpoint,
        hint: keyHint(key),
      })),
    }));
    return Promise.resolve(listing);
  }

  migrateStoredProject(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

export function createEmbeddingsSecretStore(
  secretsFile?: string,
  native?: EmbeddingsNativeStore,
  initialize?: () => Promise<EmbeddingsNativeStore | null>,
): EmbeddingsMigrationStore {
  const path = secretsFile ?? secretsFilePath();
  let backend: 'file' | 'keyring' = 'keyring';
  let loading: Promise<EmbeddingsNativeStore | null> | undefined;
  const load = () => {
    if (loading) return loading;
    const attempt = (async () => {
      if (native) return native;
      if (initialize) {
        try {
          return await initialize();
        } catch (error) {
          if (error instanceof EmbeddingsSecretStoreError) throw error;
          throw new EmbeddingsSecretStoreError('native_access', 'initialize', error);
        }
      }
      let AsyncEntry: typeof import('@napi-rs/keyring').AsyncEntry;
      try {
        ({ AsyncEntry } = await import('@napi-rs/keyring'));
      } catch (error) {
        if (error instanceof EmbeddingsSecretStoreError) throw error;
        throw new EmbeddingsSecretStoreError('native_access', 'load', error);
      }
      const service = `${currentDesktopProduct().keyringService}-embeddings`;
      const entry = (account: string) =>
        new AsyncEntry(service, account, { linux: { store: 'secret-service' } });
      try {
        entry('__probe__');
      } catch (error) {
        if (isUnavailableLinuxKeyring(error, process.platform)) return null;
        if (error instanceof EmbeddingsSecretStoreError) throw error;
        throw new EmbeddingsSecretStoreError('native_access', 'initialize', error);
      }
      return {
        get: async (account) => (await entry(account).getPassword()) ?? null,
        set: (account, key) => entry(account).setPassword(key),
        clear: async (account) => {
          await entry(account).deletePassword();
        },
      } satisfies EmbeddingsNativeStore;
    })();
    loading = attempt;
    void attempt.then(
      (value) => {
        if (value === null && loading === attempt) loading = undefined;
      },
      () => {
        if (loading === attempt) loading = undefined;
      },
    );
    return attempt;
  };
  async function run<T>(fn: (store: EmbeddingsMigrationStore) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = (async () => {
      const store = await load();
      controller.signal.throwIfAborted();
      if (!store) {
        return withEmbeddingsLock(
          path,
          async () => {
            controller.signal.throwIfAborted();
            if (
              existsSync(`${path}.embeddings-index`) ||
              existsSync(`${path}.embeddings-index.required`)
            )
              throw new EmbeddingsSecretStoreError('native_access', 'initialize');
            const file = new FileEmbeddingsBackend(path);
            try {
              file.read(true);
            } catch (error) {
              if (error instanceof EmbeddingsSecretStoreError) throw error;
              throw new EmbeddingsSecretStoreError('file_access', 'file_read', error);
            }
            backend = 'file';
            try {
              return await fn(file);
            } catch (error) {
              if (error instanceof EmbeddingsSecretStoreError) throw error;
              throw new EmbeddingsSecretStoreError('file_access', 'file_write', error);
            }
          },
          controller.signal,
        );
      }
      backend = 'keyring';
      const guarded: EmbeddingsNativeStore = {
        async get(account) {
          controller.signal.throwIfAborted();
          let value: string | null;
          try {
            value = await store.get(account);
          } catch (error) {
            if (error instanceof EmbeddingsSecretStoreError) throw error;
            throw new EmbeddingsSecretStoreError('native_access', 'native_get', error);
          }
          controller.signal.throwIfAborted();
          return value;
        },
        async set(account, key) {
          controller.signal.throwIfAborted();
          try {
            await store.set(account, key);
          } catch (error) {
            if (error instanceof EmbeddingsSecretStoreError) throw error;
            throw new EmbeddingsSecretStoreError('native_access', 'native_set', error);
          }
          controller.signal.throwIfAborted();
        },
        async clear(account) {
          controller.signal.throwIfAborted();
          try {
            await store.clear(account);
          } catch (error) {
            if (error instanceof EmbeddingsSecretStoreError) throw error;
            throw new EmbeddingsSecretStoreError('native_access', 'native_clear', error);
          }
          controller.signal.throwIfAborted();
        },
      };
      return fn(createKeychainEmbeddingsStore(path, guarded, controller.signal));
    })();
    try {
      return await Promise.race([
        operation.catch((error: unknown) => {
          if (error instanceof EmbeddingsSecretStoreError) throw error;
          throw new EmbeddingsSecretStoreError('native_access', 'operation', error);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new EmbeddingsSecretStoreError('timeout', 'timeout'));
          }, EMBEDDINGS_STORE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return {
    get backend() {
      return backend;
    },
    async resolveForProject(project, endpoint) {
      return run((store) => store.resolveForProject(project, endpoint));
    },
    async describeForProject(project, endpoint) {
      return run((store) => store.describeForProject(project, endpoint));
    },
    async getLegacyKey() {
      return run((store) => store.getLegacyKey());
    },
    async setForProject(project, endpoint, key) {
      return run((store) => store.setForProject(project, endpoint, key));
    },
    async clearForProject(project, endpoint) {
      return run((store) => store.clearForProject(project, endpoint));
    },
    async clearAllForProject(project) {
      return run((store) => store.clearAllForProject(project));
    },
    async listProjects() {
      return run((store) => store.listProjects());
    },
    async migrateStoredProject(projectKey, endpoint) {
      return run((store) => store.migrateStoredProject(projectKey, endpoint));
    },
    async clearAll() {
      return run((store) => store.clearAll());
    },
  };
}

export function makeLazyEmbeddingsKeyStore(
  secretsFile?: string,
  native?: EmbeddingsNativeStore,
): EmbeddingsKeyReader {
  return createEmbeddingsSecretStore(secretsFile, native);
}

export async function describeStoredEmbeddingsKey(
  projectDir: string,
  baseUrl: string,
  secretsFile?: string,
): Promise<EmbeddingsKeyPresence> {
  return createEmbeddingsSecretStore(secretsFile).describeForProject(projectDir, baseUrl);
}

export async function clearAllEmbeddingsKeys(
  secretsFile?: string,
): Promise<{ touched: Array<'file' | 'keychain'> }> {
  return createEmbeddingsSecretStore(secretsFile).clearAll();
}
