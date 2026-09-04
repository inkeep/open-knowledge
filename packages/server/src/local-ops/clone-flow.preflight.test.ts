import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  __resetResolveOnPathCacheForTests,
  __seedResolveOnPathCacheForTests,
} from '../git-preflight.ts';
import {
  isRecoverableGitSignal,
  withBrokenBareGitOnly,
  withUnusableGitEverywhere,
} from '../git-unusable-setup.test-helper.ts';
import { type RawCloneEvent, runCloneSubprocess } from './clone-flow.ts';

const fixtureCli = (script: string): readonly string[] => [process.execPath, '-e', script];
const RAW_GIT_FAILURE_CLI = fixtureCli(
  `process.stderr.write("xcrun: error: unable to load libxcrun (... incompatible architecture (have 'arm64', need 'arm64e')) ...\\n"); process.exit(128);`,
);

type CloneOutcome = string;

function classifyCloneOutcome(
  syncThrow: unknown,
  doneErr: unknown,
  events: readonly RawCloneEvent[],
): CloneOutcome {
  if (isRecoverableGitSignal(syncThrow)) return 'recoverable-git-preflight-signal';
  if (isRecoverableGitSignal(doneErr)) return 'recoverable-git-preflight-signal';
  if (events.some((e) => e.type === 'error' && isRecoverableGitSignal(e.message))) {
    return 'recoverable-git-preflight-signal';
  }
  const errEvent = events.find(
    (e): e is Extract<RawCloneEvent, { type: 'error' }> => e.type === 'error',
  );
  if (errEvent) return `raw-clone-error: ${errEvent.message}`;
  if (events.some((e) => e.type === 'complete')) return 'completed-as-if-success';
  if (doneErr) return `done-rejected: ${doneErr instanceof Error ? doneErr.name : String(doneErr)}`;
  if (syncThrow) return `threw: ${syncThrow instanceof Error ? syncThrow.name : String(syncThrow)}`;
  return 'no-signal';
}

describe('runCloneSubprocess — git-preflight at the clone-setup boundary (#356)', () => {
  test('surfaces the recoverable git-preflight signal (not a raw clone error) when git is unusable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok356-clone-'));
    const events: RawCloneEvent[] = [];
    let syncThrow: unknown;
    let doneErr: unknown;
    try {
      await withUnusableGitEverywhere(async () => {
        let controller: ReturnType<typeof runCloneSubprocess> | undefined;
        try {
          controller = runCloneSubprocess({
            cliArgs: RAW_GIT_FAILURE_CLI,
            url: 'https://github.com/octocat/hello.git',
            dir,
            timeoutMs: 30_000,
            onEvent: (e) => events.push(e),
          });
        } catch (err) {
          syncThrow = err;
          return;
        }
        try {
          await controller.done;
        } catch (err) {
          doneErr = err;
        }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const outcome = classifyCloneOutcome(syncThrow, doneErr, events);
    expect(outcome).toBe('recoverable-git-preflight-signal');
  });
});

function pathCapturingCli(pathFile: string, dir: string): readonly string[] {
  return [
    process.execPath,
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(pathFile)}, process.env.PATH ?? ''); console.log(JSON.stringify({ type: 'complete', dir: ${JSON.stringify(dir)} }));`,
  ];
}

describe('runCloneSubprocess — clone-child PATH binding (#356)', () => {
  test('enriches the clone child PATH with the absolute dir of the validated fallback git', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok356-clonebind-'));
    const pathFile = join(dir, 'observed-path.txt');
    try {
      await withBrokenBareGitOnly(async () => {
        const controller = runCloneSubprocess({
          cliArgs: pathCapturingCli(pathFile, dir),
          url: 'https://github.com/octocat/hello.git',
          dir,
          timeoutMs: 30_000,
          onEvent: () => {},
        });
        await controller.done;
      });

      const observed = readFileSync(pathFile, 'utf-8');
      const firstSegment = observed.split(delimiter)[0];
      expect(isAbsolute(firstSegment)).toBe(true);
      expect(existsSync(join(firstSegment, 'git'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not prepend a relative "." to the clone child PATH when the resolved git path is the bare name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok356-clonepath-'));
    const pathFile = join(dir, 'observed-path.txt');
    __resetResolveOnPathCacheForTests();
    __seedResolveOnPathCacheForTests('git', 'git');
    try {
      const controller = runCloneSubprocess({
        cliArgs: pathCapturingCli(pathFile, dir),
        url: 'https://github.com/octocat/hello.git',
        dir,
        timeoutMs: 30_000,
        onEvent: () => {},
      });
      await controller.done;

      const observed = readFileSync(pathFile, 'utf-8');
      const firstSegment = observed.split(delimiter)[0];
      expect(firstSegment).not.toBe('.');
    } finally {
      __resetResolveOnPathCacheForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
