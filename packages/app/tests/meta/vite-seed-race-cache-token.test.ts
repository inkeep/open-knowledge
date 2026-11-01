import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { withTempDir } from '../temp-dir.test-helper.ts';

const TEMP_DIR_PREFIX = 'ok-vite-race-cache-token-';
const INSTALLED = ['.vite-e2e-seed', 'react', 'vite'];
const BLANK_TOKENS = ['', ' \t '];

function installedCacheParent(appRoot: string): string {
  const parent = join(appRoot, 'node_modules');
  for (const name of INSTALLED) mkdirSync(join(parent, name), { recursive: true });
  return parent;
}

function plantedRunCopy(parent: string): string {
  const token = randomUUID();
  mkdirSync(join(parent, `.vite-race-${token}-copy`));
  return token;
}

function redirectAppRoot(appRoot: string): void {
  vi.doMock('../stress/_helpers/seed-key.ts', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../stress/_helpers/seed-key.ts')>()),
    APP_PACKAGE_ROOT: appRoot,
  }));
}

async function raceArtifactsUnder(appRoot: string) {
  vi.resetModules();
  redirectAppRoot(appRoot);
  try {
    return (await import('../stress/_helpers/vite-seed-race/race-artifacts.ts'))
      .removeRaceArtifacts;
  } finally {
    vi.doUnmock('../stress/_helpers/seed-key.ts');
    vi.resetModules();
  }
}

function exitedChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  queueMicrotask(() => child.emit('close', 1, null));
  return child;
}

describe('warm seed race consumer cache token', () => {
  test.each(BLANK_TOKENS)(
    'cleanup refuses the blank token %j, reports the refusal and removes nothing',
    async (token) => {
      await withTempDir(TEMP_DIR_PREFIX, async (appRoot) => {
        const parent = installedCacheParent(appRoot);
        const removeRaceArtifacts = await raceArtifactsUnder(appRoot);
        expect(
          removeRaceArtifacts({ runDir: undefined, consumerCacheToken: plantedRunCopy(parent) }),
        ).toEqual([]);
        expect(readdirSync(parent).sort()).toEqual(INSTALLED);

        const failures = removeRaceArtifacts({ runDir: undefined, consumerCacheToken: token });
        expect.soft(readdirSync(parent).sort()).toEqual(INSTALLED);
        expect.soft(failures).toContainEqual(expect.stringMatching(/consumer ?cache ?token/i));
      });
    },
  );

  test.each(BLANK_TOKENS)(
    'the reproduction refuses the blank token %j before it starts the harness or cleans up',
    async (token) => {
      await withTempDir(TEMP_DIR_PREFIX, async (appRoot) => {
        const parent = installedCacheParent(appRoot);
        const runDir = join(appRoot, 'run');
        mkdirSync(runDir);
        const started: string[] = [];
        const spawn = (_command: string, _args: readonly string[], options: { cwd: string }) => {
          started.push(options.cwd);
          return exitedChild();
        };
        const exitCode = process.exitCode;
        vi.stubEnv('PATH', join(appRoot, 'no-executables'));
        vi.stubEnv('VITE_RACE_RUN_DIR', runDir);
        vi.doMock('node:child_process', async (importOriginal) => ({
          ...(await importOriginal<typeof import('node:child_process')>()),
          spawn,
        }));
        redirectAppRoot(appRoot);
        try {
          vi.stubEnv('VITE_RACE_CONSUMER_CACHE_TOKEN', plantedRunCopy(parent));
          vi.resetModules();
          await expect(import('../stress/_helpers/vite-seed-race/reproduce.mjs')).rejects.toThrow(
            'bootstrap failed',
          );
          expect(started).toEqual([appRoot]);
          expect(readdirSync(parent).sort()).toEqual(INSTALLED);

          started.splice(0);
          vi.stubEnv('VITE_RACE_CONSUMER_CACHE_TOKEN', token);
          vi.resetModules();
          expect((await import('node:child_process')).spawn).toBe(spawn);
          expect((await import('../stress/_helpers/seed-key.ts')).APP_PACKAGE_ROOT).toBe(appRoot);
          const { removeRaceArtifacts } = await import(
            '../stress/_helpers/vite-seed-race/race-artifacts.ts'
          );
          expect(
            removeRaceArtifacts({ runDir: undefined, consumerCacheToken: plantedRunCopy(parent) }),
          ).toEqual([]);
          expect(readdirSync(parent).sort()).toEqual(INSTALLED);

          await expect
            .soft(import('../stress/_helpers/vite-seed-race/reproduce.mjs'))
            .rejects.toThrow('VITE_RACE_CONSUMER_CACHE_TOKEN');
          expect.soft(started).toEqual([]);
          expect.soft(readdirSync(parent).sort()).toEqual(INSTALLED);
        } finally {
          process.exitCode = exitCode;
          vi.doUnmock('node:child_process');
          vi.doUnmock('../stress/_helpers/seed-key.ts');
          vi.resetModules();
          vi.unstubAllEnvs();
        }
      });
    },
  );
});
