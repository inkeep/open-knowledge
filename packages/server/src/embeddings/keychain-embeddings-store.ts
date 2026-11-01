import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_EMBEDDINGS_BASE_URL } from '@inkeep/open-knowledge-core';
import {
  tracedMkdirSync,
  tracedRenameSync,
  tracedUnlinkSync,
  tracedWriteFileSync,
} from '../fs-traced.ts';
import { normalizeProviderId } from './embedder.ts';
import {
  canonicalProjectKey,
  EMBEDDINGS_STORE_TIMEOUT_MS,
  type EmbeddingsMigrationStore,
  EmbeddingsSecretStoreError,
  FileEmbeddingsBackend,
} from './secrets-store.ts';

export interface EmbeddingsNativeStore {
  get(account: string): Promise<string | null>;
  set(account: string, key: string): Promise<void>;
  clear(account: string): Promise<void>;
}

type Slot = { project: string; endpoint: string };
type Index = Record<string, Slot>;
const LEGACY = 'v1-legacy-default';
const DEFAULT_ENDPOINT = normalizeProviderId(DEFAULT_EMBEDDINGS_BASE_URL);

function account(project: string, endpoint: string): string {
  return `v1-${createHash('sha256')
    .update(JSON.stringify([project, endpoint]))
    .digest('hex')}`;
}

export async function withEmbeddingsLock<T>(
  secretsFile: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const lockPath = `${secretsFile}.embeddings-lock.sqlite`;
  let db: DatabaseSync;
  try {
    tracedMkdirSync(dirname(secretsFile), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(lockPath);
  } catch (error) {
    throw new EmbeddingsSecretStoreError('file_access', 'lock', error);
  }
  try {
    try {
      chmodSync(lockPath, 0o600);
      db.exec('PRAGMA busy_timeout = 0');
    } catch (error) {
      throw new EmbeddingsSecretStoreError('file_access', 'lock', error);
    }
    const deadline = Date.now() + EMBEDDINGS_STORE_TIMEOUT_MS;
    for (;;) {
      signal?.throwIfAborted();
      try {
        db.exec('BEGIN EXCLUSIVE');
        break;
      } catch (error) {
        if ((error as { errcode?: number }).errcode !== 5)
          throw new EmbeddingsSecretStoreError('file_access', 'lock', error);
        if (Date.now() >= deadline)
          throw new EmbeddingsSecretStoreError('lock_timeout', 'lock', error);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      signal?.throwIfAborted();
      return await fn();
    } finally {
      db.exec('ROLLBACK');
    }
  } finally {
    db.close();
  }
}

export function createKeychainEmbeddingsStore(
  secretsFile: string,
  native: EmbeddingsNativeStore,
  signal?: AbortSignal,
) {
  const file = new FileEmbeddingsBackend(secretsFile);
  const indexPath = `${secretsFile}.embeddings-index`;
  const markerPath = `${indexPath}.required`;

  function readIndex(): Index {
    if (!existsSync(indexPath)) {
      if (existsSync(markerPath))
        throw new EmbeddingsSecretStoreError('index_invalid', 'index_read');
      return {};
    }
    let raw: string;
    try {
      raw = readFileSync(indexPath, 'utf8');
    } catch (error) {
      throw new EmbeddingsSecretStoreError('file_access', 'index_read', error);
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new EmbeddingsSecretStoreError('index_invalid', 'index_read', error);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new EmbeddingsSecretStoreError('index_invalid', 'index_read');
    const index: Index = {};
    for (const [id, slot] of Object.entries(value)) {
      if (
        typeof slot !== 'object' ||
        slot === null ||
        !('project' in slot) ||
        !('endpoint' in slot) ||
        typeof slot.project !== 'string' ||
        typeof slot.endpoint !== 'string' ||
        (id !== LEGACY && account(slot.project, slot.endpoint) !== id)
      )
        throw new EmbeddingsSecretStoreError('index_invalid', 'index_read');
      index[id] = { project: slot.project, endpoint: slot.endpoint };
    }
    return index;
  }

  function writeIndex(index: Index): void {
    signal?.throwIfAborted();
    const tmp = `${indexPath}.tmp`;
    try {
      tracedWriteFileSync(tmp, JSON.stringify(index), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      tracedRenameSync(tmp, indexPath);
      if (!existsSync(markerPath)) tracedWriteFileSync(markerPath, '', { mode: 0o600 });
    } catch (error) {
      throw new EmbeddingsSecretStoreError('file_access', 'index_write', error);
    }
  }

  async function locked<T>(fn: () => Promise<T>): Promise<T> {
    return withEmbeddingsLock(secretsFile, fn, signal);
  }

  function readFile(): Record<string, unknown> {
    try {
      return file.read(true);
    } catch (error) {
      if (error instanceof EmbeddingsSecretStoreError) throw error;
      throw new EmbeddingsSecretStoreError('file_access', 'file_read', error);
    }
  }

  function writeFile(data: Record<string, unknown>): void {
    signal?.throwIfAborted();
    try {
      file.writeOrUnlink(data, true);
    } catch (error) {
      throw new EmbeddingsSecretStoreError('file_access', 'file_write', error);
    }
  }

  function projectMap(data: Record<string, unknown>): Record<string, unknown> {
    const projects = data.embeddings_projects;
    if (projects == null) return {};
    if (!projects || typeof projects !== 'object' || Array.isArray(projects))
      throw new EmbeddingsSecretStoreError('file_access', 'file_read');
    return projects as Record<string, unknown>;
  }

  function projectSlots(
    projects: Record<string, unknown>,
    project: string,
  ): Record<string, unknown> | undefined {
    const slots = projects[project];
    if (slots == null) return undefined;
    if (!slots || typeof slots !== 'object' || Array.isArray(slots))
      throw new EmbeddingsSecretStoreError('file_access', 'file_read');
    return slots as Record<string, unknown>;
  }

  function removeProjectSlot(
    data: Record<string, unknown>,
    project: string,
    endpoint: string,
  ): boolean {
    const projects = projectMap(data);
    const slots = projectSlots(projects, project);
    if (!slots || !Object.hasOwn(slots, endpoint)) return false;
    delete slots[endpoint];
    if (!Object.keys(slots).length) delete projects[project];
    if (!Object.keys(projects).length) delete data.embeddings_projects;
    return true;
  }

  async function readProject(
    index: Index,
    data: Record<string, unknown>,
    project: string,
    endpoint: string,
  ): Promise<string | null> {
    const id = account(project, endpoint);
    const pending = projectSlots(projectMap(data), project)?.[endpoint];
    const existing = await native.get(id);
    if (typeof pending !== 'string' || !pending) return existing;
    if (existing !== null && existing !== pending)
      throw new EmbeddingsSecretStoreError('migration_conflict', 'verify');
    index[id] = { project, endpoint };
    writeIndex(index);
    if (existing === null) {
      await native.set(id, pending);
      if ((await native.get(id)) !== pending)
        throw new EmbeddingsSecretStoreError('native_access', 'verify');
    }
    removeProjectSlot(data, project, endpoint);
    writeFile(data);
    return pending;
  }

  async function readLegacy(index: Index, data: Record<string, unknown>): Promise<string | null> {
    const first = data.OPENAI_API_KEY;
    const second = data.embeddings;
    if (
      (first != null && typeof first !== 'string') ||
      (second != null && typeof second !== 'string')
    )
      throw new EmbeddingsSecretStoreError('file_access', 'file_read');
    if (first === '' && typeof second === 'string' && second !== '')
      throw new EmbeddingsSecretStoreError('migration_conflict', 'verify');
    if (
      typeof first === 'string' &&
      first &&
      typeof second === 'string' &&
      second &&
      first !== second
    )
      throw new EmbeddingsSecretStoreError('migration_conflict', 'verify');
    const pending = first ?? second;
    const existing = await native.get(LEGACY);
    if (typeof pending !== 'string' || !pending) return existing;
    if (existing !== null && existing !== pending)
      throw new EmbeddingsSecretStoreError('migration_conflict', 'verify');
    index[LEGACY] = { project: '', endpoint: DEFAULT_ENDPOINT };
    writeIndex(index);
    if (existing === null) {
      await native.set(LEGACY, pending);
      if ((await native.get(LEGACY)) !== pending)
        throw new EmbeddingsSecretStoreError('native_access', 'verify');
    }
    delete data.OPENAI_API_KEY;
    delete data.embeddings;
    writeFile(data);
    return pending;
  }

  async function resolve(index: Index, projectDir: string, baseUrl: string) {
    const data = readFile();
    const endpoint = normalizeProviderId(baseUrl);
    const key = await readProject(index, data, canonicalProjectKey(projectDir), endpoint);
    if (key) return { key, source: 'project' as const };
    const legacy = endpoint === DEFAULT_ENDPOINT ? await readLegacy(index, data) : null;
    return { key: legacy, source: legacy ? ('file' as const) : null };
  }

  return {
    backend: 'keyring' as const,
    resolveForProject: (projectDir: string, baseUrl: string) =>
      locked(() => resolve(readIndex(), projectDir, baseUrl)),
    async describeForProject(projectDir: string, baseUrl: string) {
      const { key, source } = await this.resolveForProject(projectDir, baseUrl);
      return { present: key !== null, hint: key && key.length >= 8 ? key.slice(-4) : null, source };
    },
    getLegacyKey: () =>
      locked(async () => {
        return readLegacy(readIndex(), readFile());
      }),
    setForProject: (projectDir: string, baseUrl: string, key: string) =>
      locked(async () => {
        const index = readIndex();
        const data = readFile();
        const project = canonicalProjectKey(projectDir);
        const endpoint = normalizeProviderId(baseUrl);
        const hadFile = removeProjectSlot(data, project, endpoint);
        const id = account(project, endpoint);
        index[id] = { project, endpoint };
        writeIndex(index);
        await native.set(id, key);
        if ((await native.get(id)) !== key)
          throw new EmbeddingsSecretStoreError('native_access', 'verify');
        if (hadFile) writeFile(data);
      }),
    clearForProject: (projectDir: string, baseUrl: string) =>
      locked(async () => {
        const index = readIndex();
        const data = readFile();
        const project = canonicalProjectKey(projectDir);
        const endpoint = normalizeProviderId(baseUrl);
        const hadFile = removeProjectSlot(data, project, endpoint);
        const id = account(project, endpoint);
        const existed = (await native.get(id)) !== null;
        if (hadFile) writeFile(data);
        if (existed) {
          await native.clear(id);
          if ((await native.get(id)) !== null)
            throw new EmbeddingsSecretStoreError('native_access', 'verify');
        }
        if (Object.hasOwn(index, id)) {
          delete index[id];
          writeIndex(index);
        }
        return existed || hadFile;
      }),
    clearAllForProject: (projectDir: string) =>
      locked(async () => {
        const index = readIndex();
        const data = readFile();
        const project = canonicalProjectKey(projectDir);
        const projects = projectMap(data);
        const hadFile = projectSlots(projects, project) !== undefined;
        if (hadFile) {
          delete projects[project];
          if (!Object.keys(projects).length) delete data.embeddings_projects;
          writeFile(data);
        }
        let existed = hadFile;
        for (const [id, slot] of Object.entries(index))
          if (slot.project === project) {
            const present = (await native.get(id)) !== null;
            existed ||= present;
            if (present) await native.clear(id);
            if (present && (await native.get(id)) !== null)
              throw new EmbeddingsSecretStoreError('native_access', 'verify');
            delete index[id];
            writeIndex(index);
          }
        return existed;
      }),
    listProjects: () =>
      locked(async () => {
        const index = readIndex();
        const data = readFile();
        const projects = new Map<string, Array<{ endpoint: string; hint: string | null }>>();
        for (const [id, slot] of Object.entries(index)) {
          if (id === LEGACY) continue;
          const key = await native.get(id);
          if (!key) continue;
          const endpoints = projects.get(slot.project) ?? [];
          endpoints.push({ endpoint: slot.endpoint, hint: key.length >= 8 ? key.slice(-4) : null });
          projects.set(slot.project, endpoints);
        }
        const fileProjects = projectMap(data);
        for (const project of Object.keys(fileProjects)) {
          const slots = projectSlots(fileProjects, project);
          if (!slots) continue;
          const endpoints = projects.get(project) ?? [];
          for (const [endpoint, key] of Object.entries(slots)) {
            if (
              typeof key === 'string' &&
              key &&
              !endpoints.some((entry) => entry.endpoint === endpoint)
            ) {
              endpoints.push({ endpoint, hint: key.length >= 8 ? key.slice(-4) : null });
            }
          }
          if (endpoints.length) projects.set(project, endpoints);
        }
        return [...projects].map(([projectKey, endpoints]) => ({ projectKey, endpoints }));
      }),
    migrateStoredProject: (projectKey: string, endpoint: string) =>
      locked(async () => Boolean(await readProject(readIndex(), readFile(), projectKey, endpoint))),
    clearAll: () =>
      locked(async () => {
        const index = readIndex();
        const data = readFile();
        const hadFile =
          Object.hasOwn(data, 'embeddings_projects') ||
          Object.hasOwn(data, 'OPENAI_API_KEY') ||
          Object.hasOwn(data, 'embeddings');
        delete data.embeddings_projects;
        delete data.OPENAI_API_KEY;
        delete data.embeddings;
        if (hadFile) writeFile(data);
        let touched = false;
        for (const id of new Set([...Object.keys(index), LEGACY])) {
          if ((await native.get(id)) !== null) {
            await native.clear(id);
            if ((await native.get(id)) !== null)
              throw new EmbeddingsSecretStoreError('native_access', 'verify');
            touched = true;
          }
          if (Object.hasOwn(index, id)) {
            delete index[id];
            writeIndex(index);
          }
        }
        for (const path of [markerPath, indexPath]) {
          signal?.throwIfAborted();
          try {
            tracedUnlinkSync(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
              throw new EmbeddingsSecretStoreError('file_access', 'index_write', error);
          }
        }
        return {
          touched: [
            ...(hadFile ? ['file' as const] : []),
            ...(touched ? ['keychain' as const] : []),
          ],
        };
      }),
  } satisfies EmbeddingsMigrationStore & {
    clearAll(): Promise<{ touched: Array<'keychain' | 'file'> }>;
  };
}
