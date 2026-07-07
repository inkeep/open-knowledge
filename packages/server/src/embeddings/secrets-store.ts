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

import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { tracedMkdirSync, tracedUnlinkSync, tracedWriteFileSync } from '../fs-traced.ts';

/** `secrets.yml` field the embeddings API key is stored under — named
 * `OPENAI_API_KEY` so it's self-evident to anyone who opens the file. */
const SECRETS_KEY_FIELD = 'OPENAI_API_KEY';

/**
 * Prior field name (used briefly before the rename to `OPENAI_API_KEY`). Read as
 * a fallback so a key written by an earlier build keeps resolving instead of
 * silently vanishing, then dropped on the next `set()` — a one-shot, self-
 * clearing migration with no separate command and no steady-state read cost.
 * Harmless when no such key exists (most installs): the field is simply absent.
 */
const LEGACY_KEY_FIELD = 'embeddings';

/**
 * Absolute path of the secrets file (`<home>/.ok/secrets.yml`). `homedirOverride`
 * redirects it for tests — the same seam the config layer uses
 * (`configHomedirOverride`) — so a handler test never writes the real home.
 */
export function secretsFilePath(homedirOverride?: string): string {
  return join(homedirOverride ?? homedir(), '.ok', 'secrets.yml');
}

/** Read-only accessor the server's embedder consumes (matches `EmbeddingsKeyStore`). */
export interface EmbeddingsKeyReader {
  get(): Promise<string | null>;
}

/** Full read/write store used by the CLI commands + the set/clear HTTP handlers. */
export interface EmbeddingsSecretStore extends EmbeddingsKeyReader {
  readonly backend: 'file';
  set(key: string): Promise<void>;
  clear(): Promise<void>;
}

export class FileEmbeddingsBackend implements EmbeddingsSecretStore {
  readonly backend = 'file' as const;
  private readonly secretsFile: string;

  constructor(secretsFile?: string) {
    this.secretsFile = secretsFile ?? secretsFilePath();
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

  private write(data: Record<string, unknown>): void {
    const dir = dirname(this.secretsFile);
    // Traced writes: server-side disk I/O must emit an `fs.*` span (STOP rule;
    // @opentelemetry/instrumentation-fs doesn't work on Bun). 0600/0700 modes
    // pass straight through the wrappers.
    if (!existsSync(dir)) tracedMkdirSync(dir, { recursive: true, mode: 0o700 });
    tracedWriteFileSync(this.secretsFile, yamlStringify(data), { mode: 0o600 });
    // `mode` on writeFileSync only applies when the file is CREATED — re-assert
    // 0600 every write so a pre-existing secrets file with looser permissions
    // (older build, external tool) gets tightened. chmod is a metadata op, not a
    // content write, so it's outside the fs-traced wrappers' scope.
    chmodSync(this.secretsFile, 0o600);
  }

  // Re-reads the file on every call so a key written by `ok embeddings set-key`
  // (or the Account UI) after the server started is picked up by the next
  // search's `get()`.
  get(): Promise<string | null> {
    const data = this.read();
    // Fall back to the legacy field so a key from an earlier build still resolves.
    const value = data[SECRETS_KEY_FIELD] ?? data[LEGACY_KEY_FIELD];
    return Promise.resolve(typeof value === 'string' && value !== '' ? value : null);
  }

  set(key: string): Promise<void> {
    const data = this.read();
    // Complete the one-shot migration: the key now lives under the current field.
    delete data[LEGACY_KEY_FIELD];
    data[SECRETS_KEY_FIELD] = key;
    this.write(data);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    const data = this.read();
    // Drop both fields so a cleared key can't resurrect via the legacy fallback.
    if (SECRETS_KEY_FIELD in data || LEGACY_KEY_FIELD in data) {
      delete data[SECRETS_KEY_FIELD];
      delete data[LEGACY_KEY_FIELD];
      // Don't leave a stray empty file behind if this was the only secret —
      // unlink it so the next `get()` sees a genuinely absent store.
      if (Object.keys(data).length === 0) {
        try {
          tracedUnlinkSync(this.secretsFile);
        } catch {
          // best-effort (already gone / unwritable)
        }
      } else {
        this.write(data);
      }
    }
    return Promise.resolve();
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

/** Report whether the secrets file holds a key. Used by `ok embeddings status`. */
export async function describeStoredEmbeddingsKey(
  secretsFile?: string,
): Promise<{ file: boolean }> {
  return { file: (await new FileEmbeddingsBackend(secretsFile).get()) != null };
}

/**
 * Clear the key from the secrets file. Returns which backends had an entry
 * (always just `file` now) so callers can report honestly.
 */
export async function clearEmbeddingsKeyFromAllBackends(
  secretsFile?: string,
): Promise<{ touched: Array<'file'> }> {
  const touched: Array<'file'> = [];
  const file = new FileEmbeddingsBackend(secretsFile);
  if ((await file.get()) != null) {
    await file.clear();
    touched.push('file');
  }
  return { touched };
}
