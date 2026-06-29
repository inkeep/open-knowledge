
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { tracedMkdirSync, tracedUnlinkSync, tracedWriteFileSync } from '../fs-traced.ts';

/** `secrets.yml` field the embeddings API key is stored under — named
 * `OPENAI_API_KEY` so it's self-evident to anyone who opens the file. */
const SECRETS_KEY_FIELD = 'OPENAI_API_KEY';

const LEGACY_KEY_FIELD = 'embeddings';

export function secretsFilePath(homedirOverride?: string): string {
  return join(homedirOverride ?? homedir(), '.ok', 'secrets.yml');
}

export interface EmbeddingsKeyReader {
  get(): Promise<string | null>;
}

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

  private tightenPermsIfLoose(): void {
    let mode: number;
    try {
      mode = statSync(this.secretsFile).mode & 0o777;
    } catch {
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
    if (!existsSync(dir)) tracedMkdirSync(dir, { recursive: true, mode: 0o700 });
    tracedWriteFileSync(this.secretsFile, yamlStringify(data), { mode: 0o600 });
    chmodSync(this.secretsFile, 0o600);
  }

  get(): Promise<string | null> {
    const data = this.read();
    const value = data[SECRETS_KEY_FIELD] ?? data[LEGACY_KEY_FIELD];
    return Promise.resolve(typeof value === 'string' && value !== '' ? value : null);
  }

  set(key: string): Promise<void> {
    const data = this.read();
    delete data[LEGACY_KEY_FIELD];
    data[SECRETS_KEY_FIELD] = key;
    this.write(data);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    const data = this.read();
    if (SECRETS_KEY_FIELD in data || LEGACY_KEY_FIELD in data) {
      delete data[SECRETS_KEY_FIELD];
      delete data[LEGACY_KEY_FIELD];
      if (Object.keys(data).length === 0) {
        try {
          tracedUnlinkSync(this.secretsFile);
        } catch {
        }
      } else {
        this.write(data);
      }
    }
    return Promise.resolve();
  }
}

export function createEmbeddingsSecretStore(secretsFile?: string): EmbeddingsSecretStore {
  return new FileEmbeddingsBackend(secretsFile);
}

export function makeLazyEmbeddingsKeyStore(secretsFile?: string): EmbeddingsKeyReader {
  return new FileEmbeddingsBackend(secretsFile);
}

export async function describeStoredEmbeddingsKey(
  secretsFile?: string,
): Promise<{ file: boolean }> {
  return { file: (await new FileEmbeddingsBackend(secretsFile).get()) != null };
}

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
