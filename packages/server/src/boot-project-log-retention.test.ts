import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SPAWN_ERROR_LOG } from '@inkeep/open-knowledge-core';
import { okProjectLogsDir, openSpawnErrorLog } from '@inkeep/open-knowledge-core/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../test-support/configure-git-fixture.test-helper.ts';
import { type BootedServer, bootServer } from './boot.ts';
import { ConfigSchema } from './config/schema.ts';
import { loggerFactory } from './logger.ts';
import { prepareProjectLogsDir } from './project-logs-retention.ts';
import * as serverAuthority from './server-authority.ts';
import { shutdownTelemetry } from './telemetry.ts';

let root: string;
let projectDir: string;
let registryPath: string;
let namespace: string;
let stderrFd: number | undefined;
let booted: BootedServer | undefined;
let idleShutdown: (() => Promise<void>) | undefined;

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ok-boot-log-retention-')));
  const home = join(root, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('CODEX_HOME', join(home, '.codex'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(home, '.claude'));
  vi.stubEnv('OK_CHANNEL', 'stable');
  vi.stubEnv('OK_DISABLE_LOCAL_SINK', '0');
  vi.stubEnv('OTEL_SDK_DISABLED', 'true');
  vi.stubEnv('LOG_LEVEL', 'silent');
  vi.stubEnv('OK_CONSOLE_LEVEL', 'silent');
  vi.stubEnv('OK_FILE_LEVEL', 'debug');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(home, 'gitconfig'));
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
  projectDir = join(root, 'project');
  registryPath = join(root, 'injected-authority', 'registry.sqlite');
  namespace = okProjectLogsDir(projectDir);
  loggerFactory.reset();
  idleShutdown = undefined;
});

afterEach(async () => {
  try {
    await booted?.destroy();
  } finally {
    booted = undefined;
    if (stderrFd !== undefined) closeSync(stderrFd);
    stderrFd = undefined;
    try {
      await shutdownTelemetry();
      await loggerFactory.flushAllFileSinks();
    } finally {
      loggerFactory.reset();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

async function startBoot(localSinksEnabled: boolean): Promise<BootedServer> {
  execFileSync('git', ['init', '--initial-branch=main', projectDir], { stdio: 'pipe' });
  configureTestGitRepository(projectDir);
  mkdirSync(join(projectDir, '.ok'));
  writeFileSync(
    join(projectDir, '.ok', 'config.yml'),
    `telemetry:\n  localSink:\n    enabled: ${localSinksEnabled}\n`,
  );
  writeFileSync(join(projectDir, '.ok', '.gitignore'), '');
  const originalGuard = serverAuthority.withServerAuthorityProjectDirs;
  vi.spyOn(serverAuthority, 'withServerAuthorityProjectDirs').mockImplementation((fn, path) => {
    if (path !== registryPath) throw new Error('Boot retention did not use its injected registry');
    return originalGuard(fn, path);
  });
  booted = await bootServer({
    host: '127.0.0.1',
    config: ConfigSchema.parse({}),
    contentDir: projectDir,
    projectDir,
    authorityRegistryPath: registryPath,
    configHomedirOverride: join(root, 'home'),
    port: 0,
    quiet: true,
    gitEnabled: false,
    idleShutdownHandler: (destroy) => {
      idleShutdown = destroy;
      return destroy;
    },
  });
  await booted.ready;
  await loggerFactory.flushAllFileSinks();
  return booted;
}

test.each([
  [true, false],
  [false, false],
  [true, true],
  [false, true],
])(
  'real boot preserves final stderr through authority retirement (local sinks=%s, idle=%s)',
  async (localSinksEnabled, idle) => {
    const stderrPath = join(namespace, SPAWN_ERROR_LOG);
    stderrFd = openSpawnErrorLog(stderrPath, process.pid);
    const observations: Array<{
      beforeRelease: number;
      afterPrune: boolean;
      stderr: string | null;
    }> = [];
    const originalAcquire = serverAuthority.acquireServerAuthority;
    vi.spyOn(serverAuthority, 'acquireServerAuthority').mockImplementation((options) => {
      if (options.registryPath !== registryPath)
        throw new Error('Boot owner did not use its injected registry');
      const handle = originalAcquire(options);
      return {
        scope: handle.scope,
        release: () => {
          const beforeRelease = statSync(namespace).mtimeMs;
          handle.release();
          const currentProject = join(root, 'pruner-project');
          mkdirSync(currentProject, { recursive: true });
          prepareProjectLogsDir(currentProject, { authorityRegistryPath: registryPath });
          const afterPrune = existsSync(namespace);
          if (stderrFd === undefined) throw new Error('Owned stderr descriptor absent');
          writeSync(stderrFd, 'final stderr after authority retirement\n');
          observations.push({
            beforeRelease,
            afterPrune,
            stderr: existsSync(stderrPath) ? readFileSync(stderrPath, 'utf8') : null,
          });
        },
      };
    });
    expect(existsSync(registryPath)).toBe(false);
    const server = await startBoot(localSinksEnabled);
    const registry = new DatabaseSync(registryPath, { readOnly: true });
    try {
      expect(registry.prepare('SELECT count(*) AS count FROM server_authority').get()?.count).toBe(
        1,
      );
    } finally {
      registry.close();
    }
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    if (localSinksEnabled) {
      for (const name of [
        'server-current.jsonl',
        'server-prev.jsonl',
        'spans-current.jsonl',
        'spans-prev.jsonl',
      ]) {
        if (!existsSync(join(namespace, name))) writeFileSync(join(namespace, name), '');
      }
    } else {
      expect(readdirSync(namespace)).toEqual([SPAWN_ERROR_LOG]);
    }
    for (const name of readdirSync(namespace)) utimesSync(join(namespace, name), old, old);
    utimesSync(namespace, old, old);
    const inactivityCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    if (idle) {
      if (!idleShutdown) throw new Error('Idle shutdown callback absent');
      await idleShutdown();
    } else {
      await server.destroy();
    }
    booted = undefined;
    expect(observations).toHaveLength(1);
    expect(observations[0]?.beforeRelease).toBeGreaterThanOrEqual(inactivityCutoff);
    expect(observations[0]?.afterPrune).toBe(true);
    expect(observations[0]?.stderr).toContain('final stderr after authority retirement');
  },
);

test('disabled local sinks without existing stderr do not create a namespace during real boot or destroy', async () => {
  expect(existsSync(namespace)).toBe(false);
  const server = await startBoot(false);
  expect(existsSync(namespace)).toBe(false);
  await server.destroy();
  booted = undefined;
  expect(existsSync(namespace)).toBe(false);
});
