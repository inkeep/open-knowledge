import { spawn as nativeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { arrangeExpiredFileLock } from '../../../core/src/util/file-lock-deadline.test-helper.ts';
import { EDITOR_TARGETS } from '../../src/commands/editors.ts';
import { writeEditorMcpConfig } from '../../src/commands/init.ts';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, openSync: vi.fn(fs.openSync) };
});

const WORKER_PATH = resolve(__dirname, '_helpers', 'config-race-worker.ts');
const WORKER_TIMEOUT_MS = 30_000;

interface WorkerOutcome {
  serverKey: string;
  exitCode: number | null;
  stderr: string;
}

function spawnConfigWriter(configPath: string, serverKey: string): Promise<WorkerOutcome> {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const proc = nativeSpawn('node', ['--import', 'tsx', WORKER_PATH, configPath, serverKey], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    const timeoutHandle = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      rejectSpawn(
        new Error(`config-race-worker(${serverKey}) timed out after ${WORKER_TIMEOUT_MS}ms`),
      );
    }, WORKER_TIMEOUT_MS);
    proc.once('exit', (code) => {
      clearTimeout(timeoutHandle);
      resolveSpawn({ serverKey, exitCode: code, stderr });
    });
    proc.once('error', (err) => {
      clearTimeout(timeoutHandle);
      rejectSpawn(err);
    });
  });
}

describe('mcp host config — concurrent-write race', () => {
  let testRoot: string;
  let configPath: string;

  beforeEach(() => {
    testRoot = resolve(
      tmpdir(),
      `mcp-host-config-race-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testRoot, { recursive: true });
    configPath = join(testRoot, 'claude_desktop_config.json');
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          mcpServers: {
            'existing-cursor': { command: '/path/to/cursor-mcp' },
            'existing-handedit': { command: '/path/to/handedit-mcp' },
          },
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    rmSync(testRoot, { recursive: true, force: true });
  });

  it.each(['stable', 'disappearing'] as const)(
    'reports the acquisition deadline without changing config for a %s lock',
    async (schedule) => {
      const original = readFileSync(configPath, 'utf-8');
      await arrangeExpiredFileLock(`${configPath}.lock`, schedule, 5_000);
      const target = {
        ...EDITOR_TARGETS.cursor,
        configPath: () => configPath,
        serverName: () => 'deadline-writer',
      };

      const result = writeEditorMcpConfig(target, '', {
        mode: 'published',
        skipAvailabilityCheck: true,
      });

      expect(result.action).toBe('failed');
      expect(result.error).toBe(`Could not acquire file lock at ${configPath}.lock within 5000ms`);
      expect(readFileSync(configPath, 'utf-8')).toBe(original);
    },
  );

  it('N=20 concurrent writers all add their entries; no lost updates, no corruption, no destruction of pre-existing servers', async () => {
    const N = 20;
    const expectedKeys = Array.from({ length: N }, (_, i) => `ok-writer-${i}`);

    const writers = expectedKeys.map((key) => spawnConfigWriter(configPath, key));
    const outcomes = await Promise.all(writers);

    const workerFailures = outcomes.filter((o) => o.exitCode !== 0);
    if (workerFailures.length > 0) {
      throw new Error(
        `${workerFailures.length} / ${N} workers failed:\n${workerFailures
          .map((f) => `  ${f.serverKey}: exit=${f.exitCode} stderr=${f.stderr.trim()}`)
          .join('\n')}`,
      );
    }

    expect(existsSync(configPath)).toBe(true);
    const raw = readFileSync(configPath, 'utf-8');
    let cfg: { mcpServers?: Record<string, unknown> };
    try {
      cfg = JSON.parse(raw) as typeof cfg;
    } catch (err) {
      throw new Error(
        `Post-race file is unparseable JSON (race produced a torn write).\n` +
          `parse error: ${err instanceof Error ? err.message : String(err)}\n` +
          `bytes (first 400): ${raw.slice(0, 400)}\n` +
          `bytes (last 200):  ${raw.slice(-200)}`,
      );
    }
    const servers = cfg.mcpServers;
    if (!servers || typeof servers !== 'object') {
      throw new Error(
        `Post-race file has no mcpServers object: ${JSON.stringify(cfg).slice(0, 200)}`,
      );
    }

    const missingPreExisting = ['existing-cursor', 'existing-handedit'].filter(
      (k) => !(k in servers),
    );
    if (missingPreExisting.length > 0) {
      throw new Error(
        `Pre-existing MCP server entries destroyed by race: ${missingPreExisting.join(', ')}. ` +
          `Final keys: ${Object.keys(servers).join(', ')}`,
      );
    }

    const missingFromWrites = expectedKeys.filter((k) => !(k in servers));
    if (missingFromWrites.length > 0) {
      throw new Error(
        `${missingFromWrites.length} / ${N} concurrent writes were lost: ` +
          `${missingFromWrites.slice(0, 5).join(', ')}${
            missingFromWrites.length > 5 ? ', ...' : ''
          }. Final keys: ${Object.keys(servers).join(', ')}`,
      );
    }

    expect(Object.keys(servers).length).toBe(2 + N);
  });
});
