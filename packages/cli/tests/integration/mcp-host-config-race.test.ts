import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { arrangeExpiredFileLock } from '../../../core/src/util/file-lock-deadline.test-helper.ts';
import { EDITOR_TARGETS } from '../../src/commands/editors.ts';
import { writeEditorMcpConfig } from '../../src/commands/init.ts';
import { runConfigWriters } from './_helpers/config-race.test-helper.ts';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, openSync: vi.fn(fs.openSync) };
});

describe('mcp host config — concurrent-write race', () => {
  let testRoot: string;
  let configPath: string;
  let controller: AbortController;
  let writers: ReturnType<typeof runConfigWriters> | undefined;

  beforeEach(() => {
    controller = new AbortController();
    writers = undefined;
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

  afterEach(async () => {
    controller.abort();
    await Promise.allSettled(writers ? [writers] : []);
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

  it('N=20 concurrent writers all add their entries; no lost updates, no corruption, no destruction of pre-existing servers', {
    timeout: 0,
  }, async ({ signal }) => {
    const N = 20;
    const expectedKeys = Array.from({ length: N }, (_, i) => `ok-writer-${i}`);

    writers = runConfigWriters(configPath, expectedKeys, {
      signal: AbortSignal.any([signal, controller.signal]),
    });
    const outcomes = await writers;

    const workerFailures = outcomes.filter((o) => o.exitCode !== 0);
    if (workerFailures.length > 0) {
      throw new Error(
        `${workerFailures.length} / ${N} workers failed:\n${workerFailures
          .map(
            (f) =>
              `  ${f.serverKey}: exit=${f.exitCode} signal=${f.signal} phase=${f.phase} stderr=${f.stderr.trim()}`,
          )
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
