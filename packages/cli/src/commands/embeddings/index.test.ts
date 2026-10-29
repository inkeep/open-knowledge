import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  DEFAULT_EMBEDDINGS_BASE_URL,
  DEFAULT_EMBEDDINGS_MODEL,
  type SemanticIndexStatus,
} from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { stringify } from 'yaml';
import * as embeddingsKeyStore from '../../auth/embeddings-key-store.ts';
import { embeddingsCommand, formatSemanticCapabilityLabel } from './index.ts';

const keyring = vi.hoisted(() => ({ entries: new Map<string, string>(), mode: 'available' }));
vi.mock('@napi-rs/keyring', () => ({
  AsyncEntry: class {
    private readonly id: string;
    constructor(service: string, account: string) {
      this.id = JSON.stringify([service, account]);
    }
    async getPassword() {
      if (keyring.mode === 'error') throw new Error('sk-test-secret');
      return keyring.entries.get(this.id) ?? null;
    }
    async setPassword(value: string) {
      if (keyring.mode === 'error') throw new Error(value);
      keyring.entries.set(this.id, value);
    }
    async deletePassword() {
      return keyring.entries.delete(this.id);
    }
  },
}));

const LIVE_STATUS: SemanticIndexStatus = {
  enabled: true,
  keyPresent: false,
  keyNotRequired: true,
  keySource: null,
  keyHint: null,
  ready: true,
  capable: true,
  embedded: 2,
  total: 3,
};

function readLocalConfig(dir: string): string {
  try {
    return readFileSync(join(dir, '.ok', 'local', 'config.yml'), 'utf-8');
  } catch {
    return '';
  }
}

describe('ok embeddings set-url / clear-url', () => {
  let dir: string;
  let stderr: string;
  let restoreWrite: () => void;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-embeddings-url-'));
    stderr = '';
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      return true;
    }) as typeof process.stderr.write;
    restoreWrite = () => {
      process.stderr.write = orig;
    };
    process.exitCode = 0;
  });

  afterEach(() => {
    restoreWrite();
    process.exitCode = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  function run(...args: string[]): Promise<unknown> {
    return embeddingsCommand().parseAsync(args, { from: 'user' });
  }

  test('set-url writes a valid https endpoint to project-local config', async () => {
    await run('set-url', 'https://azure.example.com/openai/v1', '--cwd', dir);
    expect(process.exitCode).toBe(0);
    expect(readLocalConfig(dir)).toContain('https://azure.example.com/openai/v1');
  });

  test('set-url trims surrounding whitespace before writing', async () => {
    await run('set-url', '  https://azure.example.com/openai/v1  ', '--cwd', dir);
    const cfg = readLocalConfig(dir);
    expect(cfg).toContain('https://azure.example.com/openai/v1');
    expect(cfg).not.toContain('  https://');
  });

  test('set-url rejects a malformed URL without writing (exit 1)', async () => {
    await run('set-url', 'not-a-url', '--cwd', dir);
    expect(process.exitCode).toBe(1);
    expect(stderr).toContain('Not a valid URL');
    expect(readLocalConfig(dir)).toBe('');
  });

  test('set-url rejects a plaintext non-loopback endpoint without writing (exit 1)', async () => {
    await run('set-url', 'http://azure.example.com/v1', '--cwd', dir);
    expect(process.exitCode).toBe(1);
    expect(stderr).toContain('insecure endpoint');
    expect(readLocalConfig(dir)).toBe('');
  });

  test('set-url allows an http loopback endpoint (local gateway)', async () => {
    await run('set-url', 'http://localhost:11434/v1', '--cwd', dir);
    expect(process.exitCode).toBe(0);
    expect(readLocalConfig(dir)).toContain('http://localhost:11434/v1');
  });

  test('clear-url resets the endpoint to the default', async () => {
    await run('set-url', 'https://azure.example.com/openai/v1', '--cwd', dir);
    await run('clear-url', '--cwd', dir);
    expect(process.exitCode).toBe(0);
    expect(readLocalConfig(dir)).toContain(DEFAULT_EMBEDDINGS_BASE_URL);
  });

  test('set-model writes a free-text model id to project-local config', async () => {
    await run('set-model', 'nomic-embed-text', '--cwd', dir);
    expect(process.exitCode).toBe(0);
    expect(readLocalConfig(dir)).toContain('nomic-embed-text');
  });

  test('set-model trims surrounding whitespace before writing', async () => {
    await run('set-model', '  nomic-embed-text  ', '--cwd', dir);
    expect(process.exitCode).toBe(0);
    expect(readLocalConfig(dir)).toContain('nomic-embed-text');
    expect(readLocalConfig(dir)).not.toContain('  nomic-embed-text');
  });

  test('set-model rejects an empty model id without writing (exit 1)', async () => {
    await run('set-model', '   ', '--cwd', dir);
    expect(process.exitCode).toBe(1);
    expect(stderr).toContain('cannot be empty');
    expect(readLocalConfig(dir)).toBe('');
  });

  test('clear-model resets the model to the default', async () => {
    await run('set-model', 'nomic-embed-text', '--cwd', dir);
    await run('clear-model', '--cwd', dir);
    expect(process.exitCode).toBe(0);
    expect(readLocalConfig(dir)).toContain(DEFAULT_EMBEDDINGS_MODEL);
  });
});

describe('ok embeddings status transport settings', () => {
  let dir: string;
  let stdout: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-embeddings-status-'));
    stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      return true;
    });
    vi.spyOn(embeddingsKeyStore, 'resolveEmbeddingsCredential').mockResolvedValue({
      apiKey: null,
      keyless: true,
      source: 'none',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  test.each([
    { maxBatchSize: 2, maxBatchChars: 16_000, docTimeoutMs: 120_000 },
    { maxBatchSize: 96, maxBatchChars: 96_000, docTimeoutMs: 30_000 },
  ])('JSON exposes resolved transport settings: %j', async (transport) => {
    mkdirSync(join(dir, '.ok', 'local'), { recursive: true });
    writeFileSync(
      join(dir, '.ok', 'local', 'config.yml'),
      stringify({ search: { semantic: { ...transport, baseUrl: 'http://localhost:11434/v1' } } }),
    );

    await embeddingsCommand().parseAsync(['status', '--cwd', dir, '--json'], { from: 'user' });

    expect(JSON.parse(stdout)).toMatchObject({ project_config: { transport } });
  });

  test('text reports the defaults with indexing request and timeout units', async () => {
    await embeddingsCommand().parseAsync(['status', '--cwd', dir], { from: 'user' });

    expect(stdout).toContain('96 chunks maximum per indexing request');
    expect(stdout).toContain('    characters: 96000 approximate characters per indexing request');
    expect(stdout).toContain('30000 ms per indexing request attempt');
  });

  test.each([
    ['warm', 'provider initialization failed'],
    ['corpus', 'corpus indexing requests failed'],
    ['query', 'query embedding failed'],
    ['dimensions', 'RESTART REQUIRED'],
    ['configured_dimensions', "remove search.semantic.dimensions to use the model's own size"],
  ] as const)('renders the %s provider failure remedy', (providerErrorReason, expected) => {
    expect(
      formatSemanticCapabilityLabel(true, {
        ...LIVE_STATUS,
        capable: false,
        providerError: true,
        providerErrorReason,
      }),
    ).toContain(expected);
  });

  test('keeps an older boolean-only provider error visible', () => {
    expect(
      formatSemanticCapabilityLabel(true, {
        ...LIVE_STATUS,
        capable: false,
        providerError: true,
      }),
    ).toContain('provider error');
  });
});

describe('embeddings hints name the running channel CLI', () => {
  let dir: string;
  let stdout: string;
  let stderr: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-embeddings-channel-'));
    keyring.entries.clear();
    vi.stubEnv('OK_EMBEDDINGS_API_KEY', undefined);
    keyring.mode = 'available';
    stdout = '';
    stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      return true;
    });
    vi.spyOn(embeddingsKeyStore, 'resolveEmbeddingsCredential').mockResolvedValue({
      apiKey: null,
      keyless: false,
      source: 'none',
    });
    const createStore = embeddingsKeyStore.createEmbeddingsSecretStore;
    vi.spyOn(embeddingsKeyStore, 'createEmbeddingsSecretStore').mockImplementation(() =>
      keyring.mode === 'unavailable'
        ? createStore(join(dir, 'secrets.yml'), undefined, async () => null)
        : createStore(join(dir, 'secrets.yml')),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  test.each([
    ['stable', 'ok'],
    ['beta', 'ok-beta'],
  ])('%s: status, enable and set-key name %s embeddings', async (channel, command) => {
    vi.stubEnv('OK_CHANNEL', channel);
    await embeddingsCommand().parseAsync(['status', '--cwd', dir], { from: 'user' });
    expect(stdout).toContain(`  Set a key:  ${command} embeddings set-key   (or export `);
    expect(stdout).toContain(
      `  Enable it:  ${command} embeddings enable   (in this project folder)`,
    );

    await embeddingsCommand().parseAsync(['enable', '--cwd', dir], { from: 'user' });
    expect(stderr).toContain(
      `  Note: no API key set yet — run \`${command} embeddings set-key\`. Until then, search stays lexical.\n`,
    );

    vi.spyOn(process, 'stdin', 'get').mockReturnValue(
      Readable.from([Buffer.from('sk-test')]) as unknown as typeof process.stdin,
    );
    await embeddingsCommand().parseAsync(['set-key', '--cwd', dir], { from: 'user' });
    expect([...keyring.entries.values()]).toContain('sk-test');
    expect(existsSync(join(dir, 'secrets.yml'))).toBe(false);
    expect(stderr).toContain('OS credential store');
    expect(stderr).toContain(
      `  Enable semantic search with \`${command} embeddings enable\`, or in\n`,
    );
  });

  test('reports file fallback when the native credential store is unavailable', async () => {
    keyring.mode = 'unavailable';
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(
      Readable.from([Buffer.from('sk-test')]) as unknown as typeof process.stdin,
    );
    await embeddingsCommand().parseAsync(['set-key', '--cwd', dir], { from: 'user' });
    expect(readFileSync(join(dir, 'secrets.yml'), 'utf8')).toContain('sk-test');
    expect(stderr).toContain('file fallback: ~/.ok/secrets.yml, 0600');
    expect(stderr).not.toContain('OS credential store');
  });

  test.each([false, true])('status handles an inaccessible saved key (json=%s)', async (json) => {
    vi.mocked(embeddingsKeyStore.resolveEmbeddingsCredential).mockRestore();
    await embeddingsKeyStore
      .createEmbeddingsSecretStore()
      .setForProject(dir, DEFAULT_EMBEDDINGS_BASE_URL, 'sk-saved-secret');
    keyring.mode = 'error';
    await embeddingsCommand().parseAsync(['status', '--cwd', dir, ...(json ? ['--json'] : [])], {
      from: 'user',
    });
    expect(process.exitCode).toBe(1);
    if (json) {
      expect(JSON.parse(stdout).key).toMatchObject({
        present: false,
        unavailable: true,
        error: 'native_access',
      });
    } else {
      expect(stdout).toContain('unavailable');
      expect(stdout).not.toContain('Set a key:');
    }
    expect(stdout + stderr).not.toContain('sk-test-secret');
    expect(stdout + stderr).not.toContain('sk-saved-secret');
  });

  test('enable leaves configuration unchanged when saved credentials cannot be accessed', async () => {
    vi.mocked(embeddingsKeyStore.resolveEmbeddingsCredential).mockRestore();
    await embeddingsKeyStore
      .createEmbeddingsSecretStore()
      .setForProject(dir, DEFAULT_EMBEDDINGS_BASE_URL, 'sk-saved-secret');
    keyring.mode = 'error';
    await embeddingsCommand().parseAsync(['enable', '--cwd', dir], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(readLocalConfig(dir)).toBe('');
    expect(stderr).toContain('Unlock the OS credential store');
    expect(stderr).not.toContain('Semantic search enabled');
    expect(stderr).not.toContain('sk-test-secret');
  });

  test('list handles inaccessible saved credentials without exposing native error text', async () => {
    await embeddingsKeyStore
      .createEmbeddingsSecretStore()
      .setForProject(dir, DEFAULT_EMBEDDINGS_BASE_URL, 'sk-saved-secret');
    keyring.mode = 'error';
    await embeddingsCommand().parseAsync(['list'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(stderr).toContain('Unlock the OS credential store');
    expect(stderr).not.toContain('sk-test-secret');
    expect(stderr).not.toContain('No project embeddings keys');
    expect(stdout).toBe('');
  });

  test('status identifies a migration conflict and set-key repairs it through stdin', async () => {
    vi.mocked(embeddingsKeyStore.resolveEmbeddingsCredential).mockRestore();
    const store = embeddingsKeyStore.createEmbeddingsSecretStore();
    await store.setForProject(dir, DEFAULT_EMBEDDINGS_BASE_URL, 'sk-native-secret');
    writeFileSync(
      join(dir, 'secrets.yml'),
      stringify({
        embeddings_projects: {
          [realpathSync(dir)]: { [DEFAULT_EMBEDDINGS_BASE_URL]: 'sk-file-secret' },
        },
      }),
      { mode: 0o600 },
    );
    await embeddingsCommand().parseAsync(['status', '--cwd', dir, '--json'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stdout).key).toMatchObject({
      unavailable: true,
      error: 'migration_conflict',
    });
    expect(stderr).toContain('Set a project-specific key');
    expect(stdout + stderr).not.toMatch(/sk-(native|file)-secret/);
    process.exitCode = 0;
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(
      Readable.from([Buffer.from('sk-replacement')]) as unknown as typeof process.stdin,
    );
    await embeddingsCommand().parseAsync(['set-key', '--cwd', dir], { from: 'user' });
    expect(process.exitCode).toBe(0);
    expect(await store.resolveForProject(dir, DEFAULT_EMBEDDINGS_BASE_URL)).toMatchObject({
      key: 'sk-replacement',
    });
    expect(existsSync(join(dir, 'secrets.yml'))).toBe(false);
  });

  test('migrate-keys secures unused project keys and the shared legacy key', async () => {
    const other = join(dir, 'unused-project');
    mkdirSync(other);
    writeFileSync(
      join(dir, 'secrets.yml'),
      stringify({
        embeddings_projects: {
          [realpathSync(dir)]: { [DEFAULT_EMBEDDINGS_BASE_URL]: 'sk-first' },
          [realpathSync(other)]: { 'https://custom.example/v1': 'sk-unused' },
        },
        OPENAI_API_KEY: 'sk-legacy',
        unrelated: 'retained',
      }),
      { mode: 0o600 },
    );
    await embeddingsCommand().exitOverride().parseAsync(['migrate-keys'], { from: 'user' });
    expect(process.exitCode).toBe(0);
    expect(stdout).toContain('Credential scopes verified: 3. Requiring attention: 0.');
    expect(readFileSync(join(dir, 'secrets.yml'), 'utf8')).toBe('unrelated: retained\n');
    const store = embeddingsKeyStore.createEmbeddingsSecretStore();
    expect(await store.resolveForProject(other, 'https://custom.example/v1')).toMatchObject({
      key: 'sk-unused',
    });
    expect(await store.getLegacyKey()).toBe('sk-legacy');
    expect(stdout + stderr).not.toMatch(/sk-(first|unused|legacy)/);
  });

  test('migrate-keys continues past a conflict and leaves the conflicting values intact', async () => {
    const other = join(dir, 'unused-project');
    mkdirSync(other);
    const store = embeddingsKeyStore.createEmbeddingsSecretStore();
    await store.setForProject(dir, DEFAULT_EMBEDDINGS_BASE_URL, 'sk-native');
    writeFileSync(
      join(dir, 'secrets.yml'),
      stringify({
        embeddings_projects: {
          [realpathSync(dir)]: { [DEFAULT_EMBEDDINGS_BASE_URL]: 'sk-conflict' },
          [realpathSync(other)]: { 'https://custom.example/v1': 'sk-unused' },
        },
      }),
      { mode: 0o600 },
    );
    await embeddingsCommand().exitOverride().parseAsync(['migrate-keys'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(stdout).toContain('Credential scopes verified: 1. Requiring attention: 1.');
    expect(stderr).toContain('Set a project-specific key');
    const file = readFileSync(join(dir, 'secrets.yml'), 'utf8');
    expect(file).toContain('sk-conflict');
    expect(file).not.toContain('sk-unused');
    expect(await store.resolveForProject(other, 'https://custom.example/v1')).toMatchObject({
      key: 'sk-unused',
    });
    expect([...keyring.entries.values()]).toContain('sk-native');
    expect(stdout + stderr).not.toMatch(/sk-(native|conflict|unused)/);
  });

  test('migrate-keys preserves recorded identity after a project path becomes a symlink', async () => {
    const recordedPath = join(dir, 'recorded');
    const movedPath = join(dir, 'moved');
    const target = join(dir, 'target');
    mkdirSync(recordedPath);
    mkdirSync(target);
    const recordedKey = realpathSync(recordedPath);
    const store = embeddingsKeyStore.createEmbeddingsSecretStore();
    await store.setForProject(target, DEFAULT_EMBEDDINGS_BASE_URL, 'sk-target');
    writeFileSync(
      join(dir, 'secrets.yml'),
      stringify({
        embeddings_projects: { [recordedKey]: { [DEFAULT_EMBEDDINGS_BASE_URL]: 'sk-recorded' } },
        OPENAI_API_KEY: 'sk-legacy',
      }),
      { mode: 0o600 },
    );
    renameSync(recordedPath, movedPath);
    symlinkSync(target, recordedPath, process.platform === 'win32' ? 'junction' : 'dir');
    await embeddingsCommand().exitOverride().parseAsync(['migrate-keys'], { from: 'user' });
    expect(process.exitCode).toBe(0);
    expect(existsSync(join(dir, 'secrets.yml'))).toBe(false);
    expect(await store.resolveForProject(target, DEFAULT_EMBEDDINGS_BASE_URL)).toMatchObject({
      key: 'sk-target',
    });
    unlinkSync(recordedPath);
    renameSync(movedPath, recordedPath);
    expect(await store.resolveForProject(recordedPath, DEFAULT_EMBEDDINGS_BASE_URL)).toMatchObject({
      key: 'sk-recorded',
    });
    expect(stdout + stderr).not.toMatch(/sk-(target|recorded|legacy)/);
  });

  test('migrate-keys reports a disappearing scope instead of counting legacy fallback', async () => {
    const store = embeddingsKeyStore.createEmbeddingsSecretStore();
    await store.setForProject(dir, DEFAULT_EMBEDDINGS_BASE_URL, 'sk-project');
    writeFileSync(join(dir, 'secrets.yml'), stringify({ OPENAI_API_KEY: 'sk-legacy' }), {
      mode: 0o600,
    });
    vi.mocked(embeddingsKeyStore.createEmbeddingsSecretStore).mockReturnValue(store);
    const list = store.listProjects.bind(store);
    vi.spyOn(store, 'listProjects').mockImplementation(async () => {
      const entries = await list();
      await store.clearForProject(dir, DEFAULT_EMBEDDINGS_BASE_URL);
      return entries;
    });
    await embeddingsCommand().exitOverride().parseAsync(['migrate-keys'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(stdout).toContain('Credential scopes verified: 1. Requiring attention: 1.');
    expect(stderr).toContain('Stored scope was not verified');
  });

  test('migrate-keys does not call file fallback a successful native migration', async () => {
    keyring.mode = 'unavailable';
    writeFileSync(join(dir, 'secrets.yml'), stringify({ OPENAI_API_KEY: 'sk-legacy' }), {
      mode: 0o600,
    });
    await embeddingsCommand().exitOverride().parseAsync(['migrate-keys'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(stderr).toContain('No OS credential store is available');
    expect(readFileSync(join(dir, 'secrets.yml'), 'utf8')).toContain('sk-legacy');
    expect(stdout).not.toContain('Credential scopes verified');
  });

  test('does not echo credentials when the native credential store fails', async () => {
    keyring.mode = 'error';
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(
      Readable.from([Buffer.from('sk-test-secret')]) as unknown as typeof process.stdin,
    );
    await embeddingsCommand().parseAsync(['set-key', '--cwd', dir], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(stderr).toContain('Embeddings credential store is unavailable or inaccessible');
    expect(stderr).toContain('[native_set; Error; unknown]');
    expect(stderr).not.toContain('sk-test-secret');
  });
});
