/**
 * Regression: concurrent writers to an MCP host config file (Claude Desktop,
 * Cursor, Codex, etc.) must not silently lose updates, corrupt JSON, or
 * destroy unrelated pre-existing server entries.
 *
 * The original race surface is the read-modify-write loop inside
 * `writeEditorMcpConfig` (`packages/cli/src/commands/init.ts`):
 *
 *   const config = readJsonConfig(path);   // T0: read state-N
 *   const next = { ...config, [topLevelKey]: { ...servers, [key]: entry } };
 *   writeJsonConfig(path, next);           // T1: write state-N + my entry
 *
 * With no advisory lock and a naked `fs.writeFileSync`, two concurrent
 * writers that both observe `state-N` between T0 and T1 will both produce a
 * `state-N+my-entry` next-state — and the second `writeFileSync` clobbers
 * the first's entry (lost update). Two writers landing in the wrong write
 * interleave can also leave the file with valid-JSON-followed-by-trailing-
 * garbage (torn write) or — worst case — strip every pre-existing server
 * entry written by other tools (Cursor's, Codex's, hand-edited).
 *
 * Realistic triggers in production: a CLI `ok init` running concurrently
 * with OK Desktop's startup-repair MCP-wiring sweep; a user double-clicking
 * the consent-dialog Add button; two desktop instances launching against
 * the same Claude Desktop config.
 *
 * This test exercises the race at the same surface the production callers
 * hit — `writeEditorMcpConfig` against a `cursor`-shaped target whose
 * `configPath` is redirected at a fixture. N concurrent OS-level processes
 * make distinct entry additions; the post-state must contain every
 * pre-existing entry plus every concurrent addition.
 */

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
      } catch {
        // already dead
      }
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

// Skip-on-CI for the same reason as `multi-project-locks.test.ts` — cross-
// process bun spawns are unreliable on Linux GHA per oven-sh/bun#11892.
// Local runs exercise the full path.
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
    // Seed with two unrelated MCP server entries that the OK writer must not
    // destroy. These stand in for entries written by Cursor, hand-edited
    // setups, or other MCP-host tools sharing the same config file.
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

    // Every worker must exit cleanly. If any failed, surface the stderr so a
    // regression is diagnosable, but treat that as the primary failure —
    // the race symptom is downstream of an exit-0 worker that silently lost
    // its write.
    const workerFailures = outcomes.filter((o) => o.exitCode !== 0);
    if (workerFailures.length > 0) {
      throw new Error(
        `${workerFailures.length} / ${N} workers failed:\n${workerFailures
          .map((f) => `  ${f.serverKey}: exit=${f.exitCode} stderr=${f.stderr.trim()}`)
          .join('\n')}`,
      );
    }

    // The file MUST still parse as JSON. Naked `writeFileSync` interleaves
    // can leave trailing garbage past a valid JSON prefix.
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

    // Pre-existing entries from other tools MUST survive — this is the
    // worst-case failure mode (silent destruction
    // when writer A truncates → writer B reads empty → writer B writes its
    // single entry as the entire server map).
    const missingPreExisting = ['existing-cursor', 'existing-handedit'].filter(
      (k) => !(k in servers),
    );
    if (missingPreExisting.length > 0) {
      throw new Error(
        `Pre-existing MCP server entries destroyed by race: ${missingPreExisting.join(', ')}. ` +
          `Final keys: ${Object.keys(servers).join(', ')}`,
      );
    }

    // Every concurrent writer's entry MUST be present (no lost updates).
    const missingFromWrites = expectedKeys.filter((k) => !(k in servers));
    if (missingFromWrites.length > 0) {
      throw new Error(
        `${missingFromWrites.length} / ${N} concurrent writes were lost: ` +
          `${missingFromWrites.slice(0, 5).join(', ')}${
            missingFromWrites.length > 5 ? ', ...' : ''
          }. Final keys: ${Object.keys(servers).join(', ')}`,
      );
    }

    // Total: 2 pre-existing + N concurrent writers. Catches the case where
    // the file ends up with an extra key from a stale write that landed on
    // top of a fresh truncation, leaving more than expected.
    expect(Object.keys(servers).length).toBe(2 + N);
  });
});
