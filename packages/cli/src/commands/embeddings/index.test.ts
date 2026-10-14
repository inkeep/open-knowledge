import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    vi.spyOn(embeddingsKeyStore, 'createEmbeddingsSecretStore').mockReturnValue({
      setForProject: async () => {},
    } as unknown as ReturnType<typeof embeddingsKeyStore.createEmbeddingsSecretStore>);
    await embeddingsCommand().parseAsync(['set-key', '--cwd', dir], { from: 'user' });
    expect(stderr).toContain(
      `  Enable semantic search with \`${command} embeddings enable\`, or in\n`,
    );
  });
});
