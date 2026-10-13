import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as nextTurn, setTimeout as wait } from 'node:timers/promises';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  BUILD_STEP_SILENCE_MS,
  runBuildStep,
} from '../stress/_helpers/prebuilt/prebuilt-dev-build';

const HOLDER = `
import { DatabaseSync } from 'node:sqlite';
const lock = new DatabaseSync(process.argv[2]);
lock.exec('BEGIN');
lock.prepare('SELECT count(*) FROM sqlite_schema').get();
setInterval(() => {}, 1 << 30);
`;

const STALLED_BUILD = `
import { spawn } from 'node:child_process';
process.stdout.write('transforming...\\n');
spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: 'inherit' });
setInterval(() => {}, 1 << 30);
`;

const PROGRESSING_BUILD = `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];
const after = (name, then) => {
  const poll = setInterval(() => {
    if (!existsSync(join(dir, name))) return;
    clearInterval(poll);
    then();
  }, 10);
};
process.stdout.write('transforming...\\n', () => writeFileSync(join(dir, 'first-printed'), ''));
after('print-again', () => {
  process.stdout.write('rendering chunks...\\n', () => writeFileSync(join(dir, 'second-printed'), ''));
  after('finish', () => process.exit(0));
});
`;

const roots: string[] = [];

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'ok-prebuilt-silence-'));
  roots.push(root);
  return root;
}

function fixture(dir: string, name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
}

function lockHeld(path: string): boolean {
  if (!existsSync(path)) return false;
  const probe = new DatabaseSync(path, { timeout: 0 });
  try {
    probe.exec('BEGIN EXCLUSIVE');
    probe.exec('ROLLBACK');
    return false;
  } catch {
    return true;
  } finally {
    probe.close();
  }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen within 20 s`);
    await wait(10);
  }
  await nextTurn();
}

function handled(run: Promise<void>): void {
  run.catch(() => undefined);
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('a step of the prebuilt DEV app build', () => {
  test('a step that prints nothing for the whole window is stopped with every process in its group, and the error names it and keeps its output', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dir = scratch();
    const lock = join(dir, 'holder.sqlite');
    const run = runBuildStep({
      label: 'the stalled build step',
      command: process.execPath,
      args: [fixture(dir, 'stalled.mjs', STALLED_BUILD), fixture(dir, 'holder.mjs', HOLDER), lock],
      env: {},
    });
    handled(run);
    await until(() => lockHeld(lock), 'the child of the stalled build taking its lock');

    vi.advanceTimersByTime(BUILD_STEP_SILENCE_MS);

    await expect(run).rejects.toThrow(
      `the stalled build step printed nothing for ${BUILD_STEP_SILENCE_MS / 1000} s, so this run stopped it and every process in its process group; its last output:\ntransforming...\n`,
    );
    vi.useRealTimers();
    await until(() => !lockHeld(lock), 'the child of the stalled build exiting');
  });

  test('a step that keeps printing is not stopped while each silence stays shorter than the window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dir = scratch();
    const run = runBuildStep({
      label: 'the progressing build step',
      command: process.execPath,
      args: [fixture(dir, 'progressing.mjs', PROGRESSING_BUILD), dir],
      env: {},
    });
    handled(run);
    await until(() => existsSync(join(dir, 'first-printed')), 'the first output');

    vi.advanceTimersByTime(BUILD_STEP_SILENCE_MS - 1);
    writeFileSync(join(dir, 'print-again'), '');
    await until(() => existsSync(join(dir, 'second-printed')), 'the second output');
    vi.advanceTimersByTime(BUILD_STEP_SILENCE_MS - 1);
    writeFileSync(join(dir, 'finish'), '');

    await expect(run).resolves.toBeUndefined();
  });

  test('a step run through pnpm exec that hangs is stopped, and pnpm ends the command it started', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dir = scratch();
    const lock = join(dir, 'holder.sqlite');
    const run = runBuildStep({
      label: 'the stalled pnpm step',
      command: 'pnpm',
      args: ['exec', 'node', fixture(dir, 'holder.mjs', HOLDER), lock],
      env: {},
    });
    handled(run);
    await until(() => lockHeld(lock), 'the command pnpm started taking its lock');

    vi.advanceTimersByTime(BUILD_STEP_SILENCE_MS);

    await expect(run).rejects.toThrow(
      `the stalled pnpm step printed nothing for ${BUILD_STEP_SILENCE_MS / 1000} s, so this run stopped it`,
    );
    vi.useRealTimers();
    await until(() => !lockHeld(lock), 'the command pnpm started exiting');
  });

  test('a step that fails reports its exit code with the end of its output', async () => {
    const dir = scratch();
    const failing = fixture(
      dir,
      'failing.mjs',
      `process.stderr.write('vite build failed: missing entry\\n'); process.exitCode = 3;`,
    );

    await expect(
      runBuildStep({
        label: 'the failing build step',
        command: process.execPath,
        args: [failing],
        env: {},
      }),
    ).rejects.toThrow('the failing build step exited with 3\nvite build failed: missing entry\n');
  });
});
