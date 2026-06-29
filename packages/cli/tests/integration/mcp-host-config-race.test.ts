import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawn as nativeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WORKER_PATH = resolve(__dirname, '_helpers', 'config-race-worker.ts');
const WORKER_TIMEOUT_MS = 30_000;

interface WorkerOutcome {
  serverKey: string;
  exitCode: number | null;
  stderr: string;
}

function spawnConfigWriter(configPath: string, serverKey: string): Promise<WorkerOutcome> {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const proc = nativeSpawn('bun', ['run', WORKER_PATH, configPath, serverKey], {
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

const describeCrossProcess = process.env.CI ? describe.skip : describe;

describeCrossProcess('mcp host config — concurrent-write race', () => {
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
    rmSync(testRoot, { recursive: true, force: true });
  });

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
