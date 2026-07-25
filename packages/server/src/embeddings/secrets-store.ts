/**
 * Storage for the embeddings provider API key.
 *
 * A plaintext YAML file at `~/.ok/secrets.yml` (chmod 0600), user-global.
 * Deliberately NOT the OS keychain: the key is resolved on the first semantic
 * search (an agent-triggered path), and a keychain read pops an OS credential
 * prompt — and macOS re-prompts whenever the app's code signature changes (every
 * local rebuild). A 0600 file in the user's home is the conventional home for an
 * OpenAI-style API key (cf. `~/.aws/credentials`, `OPENAI_API_KEY` in `.env`)
 * and never prompts. Override at runtime with `OK_EMBEDDINGS_API_KEY` (resolved
 * in `loadOpenAiEmbedder`) for anyone who prefers an external secrets manager.
 *
 * NOT config: the key is never written to `.ok/config.yml` (committed → git
 * leak), to project-local config, or to any `ConfigSchema` field (MCP-readable,
 * Settings-rendered, loggable). `secrets.yml` is a separate, gitignored,
 * user-global file so the secret can't ride a config sync or get echoed by the
 * Settings form. Never logged or echoed back.
 *
 * Lives in `packages/server` (not the CLI) so the loopback-gated set/clear HTTP
 * handlers in `api-extension.ts` can write it directly, while the CLI
 * (`ok embeddings set-key`) imports the same logic — single source, no package
 * cycle (cli depends on server, not vice-versa).
 *
 * The GitHub credential (`token-store.ts`) still uses the OS keychain — it's
 * more sensitive (repo write) and not on a search-triggered path, so its
 * one-time "Always Allow" prompt is acceptable. This store shares no keychain
 * code with it.
 */

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
import { DEFAULT_EMBEDDINGS_BASE_URL } from '@inkeep/open-knowledge-core';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import {
  tracedMkdirSync,
  tracedRenameSync,
  tracedUnlinkSync,
  tracedWriteFileSync,
} from '../fs-traced.ts';
import { normalizeProviderId } from './embedder.ts';

/** Identity of the built-in OpenAI endpoint — the only host the legacy flat key inherits to. */
const DEFAULT_ENDPOINT_ID = normalizeProviderId(DEFAULT_EMBEDDINGS_BASE_URL);

/**
 * Machine-global legacy key field. Before per-project keys this was THE key —
 * one value sent to whatever endpoint each project configured. Now retained as
 * a host-agnostic read-only fallback (see {@link FileEmbeddingsBackend.resolveForProject}
 * step 2) so an existing single-key setup keeps working untouched on upgrade;
 * never written anymore. Named `OPENAI_API_KEY` so it's self-evident in the file.
 */
const SECRETS_KEY_FIELD = 'OPENAI_API_KEY';

/**
 * Prior field name (used briefly before the rename to `OPENAI_API_KEY`). Read as
 * a fallback so a key written by an earlier build keeps resolving instead of
 * silently vanishing. Harmless when no such key exists (most installs): the
 * field is simply absent.
 */
const LEGACY_KEY_FIELD = 'embeddings';

/**
 * Per-project, per-endpoint key map: `projectKey → normalizedEndpoint → key`.
 * The project dimension scopes keys to a project (different projects, different
 * keys); the endpoint dimension is what makes the binding STRUCTURAL — a stored
 * key has no path to a host it wasn't entered against, because resolution only
 * ever reads the slot for the endpoint currently configured. Both a per-endpoint
 * key store and a per-project override fall out of the one nested shape.
 */
const PROJECTS_FIELD = 'embeddings_projects';
type ProjectsMap = Record<string, Record<string, string>>;

/** Where a resolved key came from — surfaced (never the key) for status/UX. */
export type EmbeddingsKeySource = 'project' | 'file' | 'env' | null;

/** A resolved key plus its provenance. `key` null = nothing stored/inherited. */
export interface ResolvedEmbeddingsKey {
  key: string | null;
  source: EmbeddingsKeySource;
}

/**
 * Canonical, comparable identity for a project directory. `realpath` — NOT bare
 * `resolve` — because on macOS `/tmp/x` and `/private/tmp/x` are the same
 * directory via a symlink, and a `resolve`-keyed store would file the CLI's
 * `set-key` under one and the server's lookup under the other → a silent
 * key-miss. Falls back to `resolve` when the dir doesn't exist yet (nothing to
 * canonicalize against). `.native` normalizes drive-letter casing on Windows.
 */
export function canonicalProjectKey(projectDir: string): string {
  try {
    return realpathSync.native(projectDir);
  } catch {
    return resolve(projectDir);
  }
}

/**
 * Absolute path of the secrets file (`<home>/.ok/secrets.yml`). `homedirOverride`
 * redirects it for tests — the same seam the config layer uses
 * (`configHomedirOverride`) — so a handler test never writes the real home.
 */
export function secretsFilePath(homedirOverride?: string): string {
  return join(homedirOverride ?? homedir(), '.ok', 'secrets.yml');
}

/** One project's key status for a specific endpoint (for status / list; never the key). */
export interface EmbeddingsKeyPresence {
  present: boolean;
  /** Redacted last-4 tail when the resolved key is long enough, else null. */
  hint: string | null;
  source: EmbeddingsKeySource;
}

/** A project→endpoint→presence view for `ok embeddings list`. */
export interface EmbeddingsProjectListing {
  projectKey: string;
  endpoints: Array<{ endpoint: string; hint: string | null }>;
}

/**
 * Read-only accessor the server's embedder consumes. Resolution is
 * project + endpoint scoped: given the running server's projectDir and the
 * endpoint it's configured for, return the key bound to exactly that slot (or a
 * legacy fallback). `getLegacyKey` exposes the old flat field alone, for the
 * env/legacy presence checks that don't have an endpoint in hand.
 */
export interface EmbeddingsKeyReader {
  resolveForProject(projectDir: string, baseUrl: string): Promise<ResolvedEmbeddingsKey>;
  describeForProject(projectDir: string, baseUrl: string): Promise<EmbeddingsKeyPresence>;
  /** The machine-global legacy key alone (no project/endpoint), or null. */
  getLegacyKey(): Promise<string | null>;
}

/** Full read/write store used by the CLI commands + the set/clear HTTP handlers. */
export interface EmbeddingsSecretStore extends EmbeddingsKeyReader {
  readonly backend: 'file';
  setForProject(projectDir: string, baseUrl: string, key: string): Promise<void>;
  clearForProject(projectDir: string, baseUrl: string): Promise<boolean>;
  clearAllForProject(projectDir: string): Promise<boolean>;
  listProjects(): Promise<EmbeddingsProjectListing[]>;
}

/** Redacted last-4 tail, only when the key is long enough that 4 chars are negligible. */
function keyHint(key: string | null): string | null {
  return key && key.length >= 8 ? key.slice(-4) : null;
}

/** Max wait for the cross-process secrets lock before proceeding unlocked. */
const LOCK_TIMEOUT_MS = 2000;
/** A lock older than this is presumed abandoned (crashed writer) and stolen. */
const LOCK_STALE_MS = 10_000;

/** Block the thread ~`ms` without busy-spinning (sync path — no event loop). */
function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class FileEmbeddingsBackend implements EmbeddingsSecretStore {
  readonly backend = 'file' as const;
  private readonly secretsFile: string;

  constructor(secretsFile?: string) {
    this.secretsFile = secretsFile ?? secretsFilePath();
  }

  /**
   * Serialize a read-modify-write against the shared secrets file across
   * processes. Each project runs its own server, and every server writes the
   * WHOLE map back, so without this two servers setting a key at the same
   * instant would let the second clobber the first's project entry (a silent
   * lost update — atomic rename prevents a corrupt file, not a lost write).
   *
   * An `O_EXCL` lockfile is the mutual exclusion; a stale lock (crashed writer)
   * is stolen after {@link LOCK_STALE_MS}. Best-effort: if the lock can't be
   * taken within {@link LOCK_TIMEOUT_MS} (or at all — read-only dir), proceed
   * anyway rather than fail a credential write, degrading to the pre-existing
   * last-writer-wins. `fn` re-reads inside the lock so it merges live state.
   */
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
          // Can't create the lock at all (e.g. EACCES on ~/.ok/) — proceed
          // unlocked rather than fail a credential write, but say so: cross-
          // process serialization is silently off until the perms are fixed.
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
            continue; // stole a stale lock — retry immediately
          }
        } catch {
          continue; // lock vanished between open and stat — retry
        }
        if (Date.now() - start > LOCK_TIMEOUT_MS) break; // waited long enough — proceed unlocked
        sleepSyncMs(15);
      }
    }
    try {
      return fn();
    } finally {
      if (held) {
        try {
          unlinkSync(lockPath);
        } catch {
          // best-effort — a stale-break by another writer may have removed it
        }
      }
    }
  }

  /**
   * Self-heal the secrets file's permissions when reading. `write()` sets 0600,
   * but a file from an older build (before chmod-on-write), an external tool, or
   * a hand-edit can be left group/other-readable — and since the key is read on
   * every search yet rewritten rarely (often never), without this it could stay
   * world-readable indefinitely. Tighten to 0600 the moment a loose mode is seen.
   * Best-effort and never throws: reads are on the search path and must not fail
   * because a chmod did. chmod is a metadata op, so — like the write-path call —
   * it is outside the fs-traced requirement.
   */
  private tightenPermsIfLoose(): void {
    let mode: number;
    try {
      mode = statSync(this.secretsFile).mode & 0o777;
    } catch {
      // File vanished between existsSync and here (TOCTOU), or a filesystem
      // without POSIX modes — benign: nothing to repair, stay silent.
      return;
    }
    if ((mode & 0o077) === 0) return; // already owner-only — nothing to repair
    try {
      chmodSync(this.secretsFile, 0o600);
      process.stderr.write(
        `[embeddings] ${this.secretsFile} was readable beyond your user account ` +
          `(mode ${mode.toString(8)}); tightened to 600. It stores an API key.\n`,
      );
    } catch (e) {
      // We KNOW the file is loose but could not tighten it (read-only dir, not
      // the owner, ...). Unlike the benign stat miss above, this must not be
      // swallowed: the API key stays exposed, so say so and how to fix it. Still
      // never throws — a read on the search path must not fail because chmod did.
      const msg = e instanceof Error ? e.message : 'unknown error';
      process.stderr.write(
        `[embeddings] ${this.secretsFile} is readable beyond your user account ` +
          `(mode ${mode.toString(8)}) and could not be tightened (${msg}); your API key ` +
          `remains exposed — run: chmod 600 ${this.secretsFile}\n`,
      );
    }
  }

  private read(): Record<string, unknown> {
    if (!existsSync(this.secretsFile)) return {};
    this.tightenPermsIfLoose();
    try {
      return (yamlParse(readFileSync(this.secretsFile, 'utf-8')) ?? {}) as Record<string, unknown>;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown error';
      process.stderr.write(
        `[embeddings] Failed to parse ${this.secretsFile}: ${msg}. Starting with empty secrets.\n`,
      );
      return {};
    }
  }

  /**
   * Persist the whole map, atomically. Every mutation re-reads first (see the
   * call sites) so an interleaving write from ANOTHER project's server is not
   * clobbered wholesale; the residual is last-writer-wins if two servers set a
   * key in the exact same instant — rare (distinct projects), and never
   * corrupts the file because the swap is a rename, not an in-place rewrite.
   */
  private write(data: Record<string, unknown>): void {
    const dir = dirname(this.secretsFile);
    // Traced writes: server-side disk I/O must emit an `fs.*` span (STOP rule;
    // @opentelemetry/instrumentation-fs doesn't work on Bun). 0600/0700 modes
    // pass straight through the wrappers.
    if (!existsSync(dir)) tracedMkdirSync(dir, { recursive: true, mode: 0o700 });
    // Write to a sibling temp file then rename over the target: a reader (a
    // concurrent search resolving a key) never observes a half-written file.
    const tmp = `${this.secretsFile}.tmp`;
    tracedWriteFileSync(tmp, yamlStringify(data), { mode: 0o600 });
    chmodSync(tmp, 0o600); // `mode` only applies on create — re-assert before the swap
    tracedRenameSync(tmp, this.secretsFile);
    chmodSync(this.secretsFile, 0o600);
  }

  /** Delete the file when the map is empty, else persist it. */
  private writeOrUnlink(data: Record<string, unknown>): void {
    if (Object.keys(data).length === 0) {
      try {
        tracedUnlinkSync(this.secretsFile);
      } catch (err) {
        // Already gone → fine. Otherwise the cleared key still sits on disk and
        // the next read re-discovers it, so a "cleared" op silently didn't —
        // say so rather than report success with the bytes still there.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
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

  /**
   * Resolve the key for a project + endpoint. Re-reads the file each call so a
   * key set after the server started is picked up by the next search.
   *   1. the project's slot for this exact endpoint identity — structurally bound.
   *   2. else, ONLY for the default OpenAI endpoint, the legacy flat key — so a
   *      pre-existing single-key OpenAI setup keeps working untouched on upgrade.
   * The fallback is deliberately NOT host-agnostic: a flat key must never travel
   * to a custom endpoint it wasn't entered against (that would re-open the
   * wrong-host exfil path the per-endpoint model closes). Custom endpoints were
   * not reachable before this feature, so nothing that worked yesterday breaks.
   * The env var is resolved one layer up (`loadOpenAiEmbedder`), under the same
   * default-host scoping — the store doesn't read process state.
   */
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

  /** Remove the project's key for this endpoint. Returns whether one existed. */
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
      this.writeOrUnlink(data);
      return true;
    });
    return Promise.resolve(existed);
  }

  /**
   * Remove ALL of a project's keys (every endpoint). For `ok deinit` / removing
   * OK from a project — the whole project entry goes, not one endpoint's slot.
   * Returns whether the project had any keys.
   */
  clearAllForProject(projectDir: string): Promise<boolean> {
    const existed = this.withLock(() => {
      const data = this.read();
      const projects = this.readProjects(data);
      const pkey = canonicalProjectKey(projectDir);
      if (projects[pkey] === undefined) return false;
      delete projects[pkey];
      if (Object.keys(projects).length === 0) delete data[PROJECTS_FIELD];
      else data[PROJECTS_FIELD] = projects;
      this.writeOrUnlink(data);
      return true;
    });
    return Promise.resolve(existed);
  }

  /** Remove ALL embeddings state (every project + the legacy flat key). */
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
      if (had) this.writeOrUnlink(data);
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
}

/**
 * Create the embeddings secret store (the 0600 file backend). A factory so call
 * sites and any future backend swap stay stable.
 */
export function createEmbeddingsSecretStore(secretsFile?: string): EmbeddingsSecretStore {
  return new FileEmbeddingsBackend(secretsFile);
}

/**
 * Key reader for the server seam. A thin reader over the 0600 secrets file —
 * file reads are instant and never prompt, so there's nothing to defer or
 * time-box (unlike the keyring path this replaced).
 */
export function makeLazyEmbeddingsKeyStore(secretsFile?: string): EmbeddingsKeyReader {
  return new FileEmbeddingsBackend(secretsFile);
}

/**
 * Presence + provenance of a project's key for a given endpoint. Used by
 * `ok embeddings status` and the semantic-status HTTP read — never the key.
 */
export async function describeStoredEmbeddingsKey(
  projectDir: string,
  baseUrl: string,
  secretsFile?: string,
): Promise<EmbeddingsKeyPresence> {
  return new FileEmbeddingsBackend(secretsFile).describeForProject(projectDir, baseUrl);
}

/**
 * Wipe ALL embeddings keys — every project's per-endpoint keys plus the legacy
 * flat field. For the machine-wide `ok uninstall`. Returns `touched: ['file']`
 * when something was removed, so callers can report honestly (shape kept for the
 * removal-plan dep).
 */
export async function clearAllEmbeddingsKeys(
  secretsFile?: string,
): Promise<{ touched: Array<'file'> }> {
  return new FileEmbeddingsBackend(secretsFile).clearAll();
}
