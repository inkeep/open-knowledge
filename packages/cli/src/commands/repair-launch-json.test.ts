import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type LaunchJsonRepairLogEvent, repairLaunchJson } from './repair-launch-json.ts';

// OK no longer scaffolds `.claude/launch.json`; the `ok start` repair sweep now
// REMOVES any `open-knowledge-ui` entry a prior OK version left behind. The
// surgical removal itself is covered in launch-json-removal.test.ts; here we
// pin the sweep wrapper's outcomes, its structured event, and the reclaim gate.
describe('repairLaunchJson (remove sweep)', () => {
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

  const OK_ENTRY = {
    name: 'open-knowledge-ui',
    runtimeExecutable: '/bin/sh',
    runtimeArgs: ['-l', '-c', '# ok-ui-v1\nexec ok start'],
    port: 39848,
  };
  const FOREIGN = {
    name: 'some-other-tool',
    runtimeExecutable: 'node',
    runtimeArgs: ['./server.js'],
  };

  it("removes OK's entry, preserving co-located configurations", () => {
    const configPath = writeLaunchJson({ version: '0.0.1', configurations: [FOREIGN, OK_ENTRY] });

    const result = repairLaunchJson({ projectDir, logger });

    expect(result.outcome.outcome).toBe('removed');
    expect(result.outcome.configPath).toBe(configPath);
    expect(result.repairedCount).toBe(1);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.configurations).toHaveLength(1);
    expect(written.configurations[0]).toEqual(FOREIGN);
    expect(logEvents).toContainEqual({ event: 'launch-json-repair-removed', configPath });
  });

  it("removes the whole file when OK's entry was the only configuration", () => {
    const configPath = writeLaunchJson({ version: '0.0.1', configurations: [OK_ENTRY] });

    const result = repairLaunchJson({ projectDir, logger });

    expect(result.outcome.outcome).toBe('removed-file');
    expect(result.repairedCount).toBe(1);
    expect(existsSync(configPath)).toBe(false);
  });

  it('reports not-present when no launch.json exists, and does not create one', () => {
    const result = repairLaunchJson({ projectDir, logger });

    expect(result.outcome.outcome).toBe('not-present');
    expect(result.outcome.configPath).toBe(join(projectDir, '.claude', 'launch.json'));
    expect(result.repairedCount).toBe(0);
    expect(existsSync(join(projectDir, '.claude', 'launch.json'))).toBe(false);
    expect(logEvents).toHaveLength(0);
  });

  it('reports not-present when launch.json has no open-knowledge-ui entry', () => {
    const configPath = writeLaunchJson({ version: '0.0.1', configurations: [FOREIGN] });
    const before = readFileSync(configPath, 'utf-8');

    const result = repairLaunchJson({ projectDir, logger });

    expect(result.outcome.outcome).toBe('not-present');
    expect(result.repairedCount).toBe(0);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('OK_RECLAIM_DISABLE=1 short-circuits with a structured event and no removal', () => {
    const configPath = writeLaunchJson({ version: '0.0.1', configurations: [OK_ENTRY] });
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
    const result = repairLaunchJson({ projectDir, logger, reclaimDisableEnv: '1' });
    expect(result.outcome.outcome).toBe('skipped-reclaim-disabled');
    expect(logEvents).toEqual([
      { event: 'launch-json-repair-skipped', reason: 'reclaim-disabled' },
    ]);
  });
});
