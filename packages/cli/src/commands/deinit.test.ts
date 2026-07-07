import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { MCP_SERVER_NAME } from '@inkeep/open-knowledge-server';
import { runDeinit } from './deinit.ts';
import { buildManagedServerEntry } from './editors.ts';

const OWN_ENTRY = buildManagedServerEntry({ mode: 'published' });

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A temp OK project with a realistic footprint + a markdown content file. */
function seedProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-deinit-'));
  write(join(dir, '.ok', 'config.yml'), 'content:\n  dir: .\n');
  write(join(dir, '.ok', 'local', 'server.lock'), '{}');
  write(join(dir, '.okignore'), 'secret.md\n');
  write(
    join(dir, '.mcp.json'),
    `${JSON.stringify({ mcpServers: { mine: { command: 'x' }, [MCP_SERVER_NAME]: OWN_ENTRY } }, null, 2)}\n`,
  );
  write(join(dir, '.claude', 'skills', 'open-knowledge', 'SKILL.md'), '# ok\n');
  // The user's actual content — must survive.
  write(join(dir, 'notes.md'), '# my notes\n');
  return dir;
}

describe('runDeinit', () => {
  test('no-op with a clear message when the dir is not an OK project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-deinit-'));
    try {
      const result = await runDeinit({ cwd: dir, home: dir, yes: true });
      expect(result.status).toBe('no-op');
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dry-run shows the plan and removes nothing', async () => {
    const dir = seedProject();
    try {
      const result = await runDeinit({ cwd: dir, home: dir, dryRun: true });
      expect(result.status).toBe('dry-run');
      expect(result.message).toContain('Remove');
      expect(existsSync(join(dir, '.ok'))).toBe(true); // untouched
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('empty prompt input (bare Enter) aborts — defaults to No', async () => {
    const dir = seedProject();
    try {
      const result = await runDeinit({
        cwd: dir,
        home: dir,
        confirmStream: Readable.from(['\n']),
      });
      expect(result.status).toBe('cancelled');
      expect(existsSync(join(dir, '.ok'))).toBe(true); // nothing removed
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('removes the project footprint while leaving markdown content untouched', async () => {
    const dir = seedProject();
    try {
      const result = await runDeinit({ cwd: dir, home: dir, yes: true });
      expect(result.status).toBe('done');
      expect(result.exitCode).toBe(0);
      // OK footprint gone.
      expect(existsSync(join(dir, '.ok'))).toBe(false);
      expect(existsSync(join(dir, '.okignore'))).toBe(false);
      expect(existsSync(join(dir, '.claude', 'skills', 'open-knowledge'))).toBe(false);
      // .mcp.json: OK entry surgically removed, the user's other server kept.
      const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8'));
      expect(mcp.mcpServers[MCP_SERVER_NAME]).toBeUndefined();
      expect(mcp.mcpServers.mine).toEqual({ command: 'x' });
      // Markdown content survives.
      expect(readFileSync(join(dir, 'notes.md'), 'utf-8')).toBe('# my notes\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--json without --yes is rejected (no interactive prompt possible)', async () => {
    const dir = seedProject();
    try {
      const result = await runDeinit({ cwd: dir, home: dir, json: true });
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reports failed + exit 1 when an op fails (a server won’t stop)', async () => {
    const dir = seedProject();
    try {
      const result = await runDeinit({
        cwd: dir,
        home: dir,
        yes: true,
        runRemovalDeps: {
          // The project's SIGTERM fails → the stop-server op is `failed`.
          stopServer: () => ({ stopped: 0, failed: [{ pid: 77, error: 'EPERM' }] }),
        },
      });
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
