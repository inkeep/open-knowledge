import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_EMBEDDINGS_BASE_URL } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { embeddingsCommand } from './index.ts';

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
    // Command actions set `process.exitCode = 1` on failure and leave it on
    // success. Bun's `process.exitCode = undefined` does NOT clear a prior value,
    // so reset to 0 ("success") before each test — and again after, so a reject
    // test's exit code never leaks to the `bun test` process.
    process.exitCode = 0;
  });

  afterEach(() => {
    restoreWrite();
    process.exitCode = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  // Build a fresh command each run so commander carries no state between calls.
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
});
