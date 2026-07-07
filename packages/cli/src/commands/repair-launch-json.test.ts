import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LAUNCH_UI_CHAIN_SENTINEL, LAUNCH_UI_CHAIN_V1 } from './init.ts';
import {
  classifyLaunchJsonEntry,
  type LaunchJsonRepairLogEvent,
  repairLaunchJson,
} from './repair-launch-json.ts';

// Current canonical recipe — the `# ok-ui-v1` `/bin/sh` chain that runs
// `ok start` (not bare `ok ui`), so a worktree gets its own collab server.
const CANONICAL_ENTRY = {
  name: 'open-knowledge-ui',
  runtimeExecutable: '/bin/sh',
  runtimeArgs: ['-l', '-c', LAUNCH_UI_CHAIN_V1],
  port: 50219,
  autoPort: true,
};

// Published shape (`npx @latest ui`). Launched a bare UI with no collab
// server — now a `legacy-bare` form that migrates forward to the chain.
const LEGACY_AT_LATEST_ENTRY = {
  name: 'open-knowledge-ui',
  runtimeExecutable: 'npx',
  runtimeArgs: ['-y', '@inkeep/open-knowledge@latest', 'ui'],
  port: 50219,
  autoPort: true,
};

const LEGACY_BARE_ENTRY = {
  name: 'open-knowledge-ui',
  runtimeExecutable: 'npx',
  runtimeArgs: ['@inkeep/open-knowledge', 'ui'],
  port: 50219,
  autoPort: true,
};

const LEGACY_BARE_WITH_Y_ENTRY = {
  name: 'open-knowledge-ui',
  runtimeExecutable: 'npx',
  runtimeArgs: ['-y', '@inkeep/open-knowledge', 'ui'],
  port: 50219,
  autoPort: true,
};

/** Assert a rewritten entry is the current canonical chain shape. */
function expectCanonicalChain(entry: { runtimeExecutable: string; runtimeArgs: string[] }): void {
  expect(entry.runtimeExecutable).toBe('/bin/sh');
  expect(entry.runtimeArgs.slice(0, 2)).toEqual(['-l', '-c']);
  expect(entry.runtimeArgs[2]).toContain(LAUNCH_UI_CHAIN_SENTINEL);
  expect(entry.runtimeArgs[2]).toContain('start');
}

describe('classifyLaunchJsonEntry', () => {
  it('returns "canonical" for the current ok-start `# ok-ui-v1` chain', () => {
    expect(classifyLaunchJsonEntry(CANONICAL_ENTRY)).toBe('canonical');
  });

  it('returns "legacy-bare" for the pre-D5 published `npx @latest ui` shape', () => {
    expect(classifyLaunchJsonEntry(LEGACY_AT_LATEST_ENTRY)).toBe('legacy-bare');
  });

  it('returns "legacy-bare" for an older `# ok-ui-vN` chain we no longer ship', () => {
    expect(
      classifyLaunchJsonEntry({
        name: 'open-knowledge-ui',
        runtimeExecutable: '/bin/sh',
        runtimeArgs: ['-l', '-c', '# ok-ui-v0\nexec ok ui'],
      }),
    ).toBe('legacy-bare');
  });

  it('returns "preserved" for a foreign /bin/sh command without our sentinel', () => {
    expect(
      classifyLaunchJsonEntry({
        name: 'open-knowledge-ui',
        runtimeExecutable: '/bin/sh',
        runtimeArgs: ['-c', 'my-own-launcher --flag'],
      }),
    ).toBe('preserved');
  });

  it('returns "legacy-bare" for the unpinned 2-arg npx shape', () => {
    expect(classifyLaunchJsonEntry(LEGACY_BARE_ENTRY)).toBe('legacy-bare');
  });

  it('returns "legacy-bare" for the unpinned -y 3-arg npx shape', () => {
    expect(classifyLaunchJsonEntry(LEGACY_BARE_WITH_Y_ENTRY)).toBe('legacy-bare');
  });

  it('returns "preserved" when the package is pinned to @beta', () => {
    expect(
      classifyLaunchJsonEntry({
        name: 'open-knowledge-ui',
        runtimeExecutable: 'npx',
        runtimeArgs: ['-y', '@inkeep/open-knowledge@beta', 'ui'],
      }),
    ).toBe('preserved');
  });

  it('returns "preserved" when the package is pinned to a concrete version', () => {
    expect(
      classifyLaunchJsonEntry({
        name: 'open-knowledge-ui',
        runtimeExecutable: 'npx',
        runtimeArgs: ['-y', '@inkeep/open-knowledge@0.5.0', 'ui'],
      }),
    ).toBe('preserved');
  });

  it('returns "preserved" when the bare @latest spec omits the -y flag', () => {
    // Forward-migration only — entries that already pin @latest but happen
    // to lack `-y` are user-curated; leave them. Mirrors the MCP classifier.
    expect(
      classifyLaunchJsonEntry({
        name: 'open-knowledge-ui',
        runtimeExecutable: 'npx',
        runtimeArgs: ['@inkeep/open-knowledge@latest', 'ui'],
      }),
    ).toBe('preserved');
  });

  it('returns "preserved" for dev-mode (runtimeExecutable=node, dist path)', () => {
    expect(
      classifyLaunchJsonEntry({
        name: 'open-knowledge-ui',
        runtimeExecutable: 'node',
        runtimeArgs: ['/path/to/packages/cli/dist/cli.mjs', 'ui'],
      }),
    ).toBe('preserved');
  });

  it('returns "preserved" for an arbitrary custom command', () => {
    expect(
      classifyLaunchJsonEntry({
        name: 'open-knowledge-ui',
        runtimeExecutable: 'my-wrapper',
        runtimeArgs: ['ui'],
      }),
    ).toBe('preserved');
  });

  it('returns "preserved" for legacy bare shape with extra trailing args', () => {
    // Foreign-customized — e.g. someone appended `--port 9999`. Don't touch.
    expect(
      classifyLaunchJsonEntry({
        name: 'open-knowledge-ui',
        runtimeExecutable: 'npx',
        runtimeArgs: ['@inkeep/open-knowledge', 'ui', '--port', '9999'],
      }),
    ).toBe('preserved');
  });

  it('returns "preserved" for entries with non-array runtimeArgs', () => {
    expect(
      classifyLaunchJsonEntry({
        name: 'open-knowledge-ui',
        runtimeExecutable: 'npx',
        runtimeArgs: 'ui',
      }),
    ).toBe('preserved');
  });

  it('returns "preserved" for entries with non-string runtimeExecutable', () => {
    expect(
      classifyLaunchJsonEntry({
        name: 'open-knowledge-ui',
        runtimeExecutable: 42,
        runtimeArgs: ['@inkeep/open-knowledge', 'ui'],
      }),
    ).toBe('preserved');
  });

  it('returns "preserved" for empty entries', () => {
    expect(classifyLaunchJsonEntry({})).toBe('preserved');
  });
});

describe('repairLaunchJson', () => {
  let testDir: string;
  let projectDir: string;
  let logEvents: LaunchJsonRepairLogEvent[];
  const logger = (event: LaunchJsonRepairLogEvent) => {
    logEvents.push(event);
  };

  beforeEach(() => {
    testDir = resolve(
      tmpdir(),
      `repair-launch-json-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    projectDir = join(testDir, 'project');
    mkdirSync(projectDir, { recursive: true });
    logEvents = [];
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeLaunchJson(content: unknown): string {
    const dir = join(projectDir, '.claude');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'launch.json');
    writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`);
    return path;
  }

  it('rewrites a legacy bare entry forward to the canonical @latest shape', () => {
    const configPath = writeLaunchJson({
      version: '0.0.1',
      configurations: [LEGACY_BARE_ENTRY],
    });

    const result = repairLaunchJson({ projectDir, logger });

    expect(result.outcome.outcome).toBe('repaired');
    expect(result.outcome.configPath).toBe(configPath);
    expect(result.repairedCount).toBe(1);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.configurations).toHaveLength(1);
    expectCanonicalChain(written.configurations[0]);
    expect(written.configurations[0].name).toBe('open-knowledge-ui');

    expect(logEvents).toContainEqual({
      event: 'launch-json-repair-applied',
      configPath,
    });
  });

  it('rewrites the -y legacy variant forward', () => {
    const configPath = writeLaunchJson({
      version: '0.0.1',
      configurations: [LEGACY_BARE_WITH_Y_ENTRY],
    });

    const result = repairLaunchJson({ projectDir, logger });

    expect(result.outcome.outcome).toBe('repaired');
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expectCanonicalChain(written.configurations[0]);
  });

  it('leaves an already-canonical entry untouched (outcome=canonical, no rewrite)', () => {
    const configPath = writeLaunchJson({
      version: '0.0.1',
      configurations: [CANONICAL_ENTRY],
    });
    const before = readFileSync(configPath, 'utf-8');

    const result = repairLaunchJson({ projectDir, logger });

    expect(result.outcome.outcome).toBe('canonical');
    expect(result.repairedCount).toBe(0);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
    expect(logEvents.filter((e) => e.event === 'launch-json-repair-applied')).toHaveLength(0);
  });

  it('preserves a @beta-pinned entry (user intent)', () => {
    const configPath = writeLaunchJson({
      version: '0.0.1',
      configurations: [
        {
          name: 'open-knowledge-ui',
          runtimeExecutable: 'npx',
          runtimeArgs: ['-y', '@inkeep/open-knowledge@beta', 'ui'],
          port: 50219,
          autoPort: true,
        },
      ],
    });
    const before = readFileSync(configPath, 'utf-8');

    const result = repairLaunchJson({ projectDir, logger });

    expect(result.outcome.outcome).toBe('preserved');
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('preserves a dev-mode entry (runtimeExecutable=node)', () => {
    const configPath = writeLaunchJson({
      version: '0.0.1',
      configurations: [
        {
          name: 'open-knowledge-ui',
          runtimeExecutable: 'node',
          runtimeArgs: ['/some/dist/cli.mjs', 'ui'],
          port: 50219,
          autoPort: true,
        },
      ],
    });
    const before = readFileSync(configPath, 'utf-8');

    const result = repairLaunchJson({ projectDir, logger });

    expect(result.outcome.outcome).toBe('preserved');
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('preserves co-located non-OK configurations when rewriting', () => {
    // Real launch.json files often have other dev tooling configs alongside.
    // The repair sweep must rewrite only our entry and leave the rest intact.
    const foreignConfig = {
      name: 'some-other-tool',
      runtimeExecutable: 'node',
      runtimeArgs: ['./server.js'],
      port: 9001,
    };
    const configPath = writeLaunchJson({
      version: '0.0.1',
      configurations: [foreignConfig, LEGACY_BARE_ENTRY],
    });

    const result = repairLaunchJson({ projectDir, logger });

    expect(result.outcome.outcome).toBe('repaired');
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.configurations).toHaveLength(2);
    expect(
      written.configurations.find((c: { name: string }) => c.name === 'some-other-tool'),
    ).toEqual(foreignConfig);
    const okEntry = written.configurations.find(
      (c: { name: string }) => c.name === 'open-knowledge-ui',
    );
    expectCanonicalChain(okEntry);
  });

  it('reports no-file when .claude/launch.json does not exist', () => {
    const result = repairLaunchJson({ projectDir, logger });

    expect(result.outcome.outcome).toBe('no-file');
    expect(result.outcome.configPath).toBe(join(projectDir, '.claude', 'launch.json'));
    expect(result.repairedCount).toBe(0);
    expect(logEvents).toHaveLength(0);
  });

  it('does not create launch.json when it was absent', () => {
    // Negative-coverage: a sweep that does nothing must not silently scaffold.
    repairLaunchJson({ projectDir, logger });
    expect(existsSync(join(projectDir, '.claude', 'launch.json'))).toBe(false);
  });

  it('reports no-entry when launch.json exists but has no open-knowledge-ui config', () => {
    writeLaunchJson({
      version: '0.0.1',
      configurations: [
        { name: 'some-other-tool', runtimeExecutable: 'node', runtimeArgs: ['./server.js'] },
      ],
    });

    const result = repairLaunchJson({ projectDir, logger });

    expect(result.outcome.outcome).toBe('no-entry');
    expect(result.repairedCount).toBe(0);
  });

  it('reports no-entry when configurations is missing entirely', () => {
    writeLaunchJson({ version: '0.0.1' });

    const result = repairLaunchJson({ projectDir, logger });

    expect(result.outcome.outcome).toBe('no-entry');
  });

  it('reports read-failed and emits the structured event on malformed JSON', () => {
    const dir = join(projectDir, '.claude');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'launch.json');
    writeFileSync(path, '{ not valid json');

    const result = repairLaunchJson({ projectDir, logger });

    expect(result.outcome.outcome).toBe('read-failed');
    expect(typeof result.outcome.error).toBe('string');
    expect(result.outcome.error?.length ?? 0).toBeGreaterThan(0);

    const readFailed = logEvents.find((e) => e.event === 'launch-json-repair-read-failed');
    expect(readFailed).toBeDefined();
    expect(readFailed?.configPath).toBe(path);
    expect(typeof readFailed?.error).toBe('string');
  });

  it('reports read-failed and emits the structured event on non-object root', () => {
    // Symmetric with the JSON-parse-error branch — both surface
    // structurally-broken files via the same `launch-json-repair-read-failed`
    // event so operators tailing stderr see them, not just unparseable JSON.
    const dir = join(projectDir, '.claude');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'launch.json');
    writeFileSync(path, JSON.stringify([{ name: 'open-knowledge-ui' }]));

    const result = repairLaunchJson({ projectDir, logger });

    expect(result.outcome.outcome).toBe('read-failed');
    expect(result.outcome.error).toBe('launch.json root is not an object');

    const readFailed = logEvents.find((e) => e.event === 'launch-json-repair-read-failed');
    expect(readFailed).toBeDefined();
    expect(readFailed?.configPath).toBe(path);
    expect(readFailed?.error).toBe('launch.json root is not an object');
  });

  it('emits a single stderr JSON line per repair when no logger is injected', () => {
    writeLaunchJson({ version: '0.0.1', configurations: [LEGACY_BARE_ENTRY] });

    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    }) as typeof process.stderr.write;

    try {
      repairLaunchJson({ projectDir });
    } finally {
      process.stderr.write = origWrite;
    }

    const appliedLines = writes.filter((w) => w.includes('"launch-json-repair-applied"'));
    expect(appliedLines.length).toBe(1);
    const parsed = JSON.parse(appliedLines[0].trim());
    expect(parsed.event).toBe('launch-json-repair-applied');
    expect(parsed.configPath).toContain('launch.json');
  });

  it('reports write-failed and emits the structured event when the file is unwritable', () => {
    const configPath = writeLaunchJson({
      version: '0.0.1',
      configurations: [LEGACY_BARE_ENTRY],
    });
    chmodSync(configPath, 0o444);
    try {
      const result = repairLaunchJson({ projectDir, logger });

      expect(result.outcome.outcome).toBe('write-failed');
      expect(typeof result.outcome.error).toBe('string');
      expect(result.outcome.error?.length ?? 0).toBeGreaterThan(0);
      expect(result.repairedCount).toBe(0);

      const writeFailed = logEvents.find((e) => e.event === 'launch-json-repair-write-failed');
      expect(writeFailed).toBeDefined();
      expect(writeFailed?.configPath).toBe(configPath);
      expect(typeof writeFailed?.error).toBe('string');
    } finally {
      // Restore writeability so afterEach's rmSync doesn't trip on a
      // read-only file inside the test scratch tree.
      chmodSync(configPath, 0o644);
    }
  });

  it('rewrites only the first matching entry when somehow duplicated', () => {
    // Defensive — `scaffoldLaunchJson` uses findIndex which targets the first
    // match, so a hypothetical duplicate-named launch.json (manual edit, merge
    // conflict resolved by appending) gets the first entry repaired. Pinning
    // this behavior so the helper's findIndex contract can't drift to findLast.
    const configPath = writeLaunchJson({
      version: '0.0.1',
      configurations: [LEGACY_BARE_ENTRY, { ...LEGACY_BARE_ENTRY, port: 99999 }],
    });

    const result = repairLaunchJson({ projectDir, logger });

    expect(result.outcome.outcome).toBe('repaired');
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.configurations).toHaveLength(2);
    expectCanonicalChain(written.configurations[0]);
    // Second duplicate is left alone (findIndex returns first match only).
    expect(written.configurations[1].runtimeArgs).toEqual(['@inkeep/open-knowledge', 'ui']);
  });

  it('AC-C3: OK_RECLAIM_DISABLE=1 short-circuits with a structured event and no rewrite', () => {
    const configPath = writeLaunchJson({
      version: '0.0.1',
      configurations: [LEGACY_BARE_ENTRY],
    });
    const before = readFileSync(configPath, 'utf-8');

    const result = repairLaunchJson({ projectDir, logger, reclaimDisableEnv: '1' });

    expect(result.outcome.outcome).toBe('skipped-reclaim-disabled');
    expect(result.outcome.configPath).toBe(configPath);
    expect(result.repairedCount).toBe(0);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
    expect(logEvents).toEqual([
      { event: 'launch-json-repair-skipped', reason: 'reclaim-disabled' },
    ]);
  });

  it('skipped-reclaim-disabled fires even when no launch.json exists', () => {
    // Distinct from no-file because the env gate runs before the existsSync check.
    const result = repairLaunchJson({ projectDir, logger, reclaimDisableEnv: '1' });
    expect(result.outcome.outcome).toBe('skipped-reclaim-disabled');
    expect(logEvents).toEqual([
      { event: 'launch-json-repair-skipped', reason: 'reclaim-disabled' },
    ]);
  });
});
