import { type SpawnOptions, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ensureProjectGit } from '@inkeep/open-knowledge-server';
import { z } from 'zod';
import { configureTestGitRepository } from '../../../../test-support/configure-git-fixture.test-helper.ts';
import { testAuthorityRegistryPath } from '../../../../test-support/server-authority-registry.test-helper.ts';
import { withHiddenWindowsConsole } from '../../../server/src/child-process-windows-hide.ts';
import { getFreePort } from '../free-port.test-helper.ts';
import { removeAllStrictDuringTeardown } from '../stress/_helpers/teardown-fs.ts';
import type { CreateTestServerOptions } from './test-harness.ts';

export interface RestartableServer {
  port: number;
  contentDir: string;
  pid: number;
  serverInstanceId: string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  killNetwork(): void;
  disconnectOwner(): void;
  shutdown(): Promise<void>;
  killAndRestartOnSamePort(opts: { downtimeMs: number }): Promise<RestartableServer>;
  shutdownAndRestartOnSamePort(opts: { downtimeMs: number }): Promise<RestartableServer>;
}

export interface CreateRestartableServerOptions extends CreateTestServerOptions {
  port?: number;
}

export interface RestartWorkerOptions {
  authorityRegistryPath: string;
  contentDir: string;
  configHomedirOverride: string;
  port: number;
  debounce: number;
  maxDebounce: number;
  gitEnabled: boolean;
  commitDebounceMs: number;
  keepaliveGraceMs?: number;
}

const receiptSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    port: z.number().int().positive(),
    pid: z.number().int().positive(),
    serverInstanceId: z.string().min(1),
  }),
  z.object({ status: z.literal('error'), message: z.string() }),
]);

export async function createRestartableServer(
  options: CreateRestartableServerOptions = {},
): Promise<RestartableServer> {
  const contentDir = realpathSync.native(
    options.contentDir ?? mkdtempSync(join(tmpdir(), 'ok-restartable-')),
  );
  const home = options.configHomedirOverride ?? mkdtempSync(join(tmpdir(), 'ok-restart-home-'));
  mkdirSync(join(contentDir, '.ok'), { recursive: true });
  if (options.contentDir === undefined) {
    writeFileSync(join(contentDir, 'test-doc.md'), '');
  }
  if (!existsSync(join(contentDir, '.ok', 'config.yml'))) {
    writeFileSync(join(contentDir, '.ok', 'config.yml'), options.seedProjectConfigYml ?? '');
  }
  writeFileSync(join(contentDir, '.ok', '.gitignore'), '*\n');
  await ensureProjectGit(contentDir);
  configureTestGitRepository(contentDir);
  const port = options.port ?? (await getFreePort());
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./restartable-server-worker.test-helper.ts', import.meta.url)),
    ],
    withHiddenWindowsConsole({
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, HOME: home, USERPROFILE: home },
    } satisfies SpawnOptions),
  );
  let diagnostics = '';
  const capture = (chunk: Buffer): void => {
    diagnostics = (diagnostics + chunk.toString()).slice(-16_384);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  const ready = Promise.withResolvers<z.infer<typeof receiptSchema>>();
  child.on('message', (message) => {
    const parsed = receiptSchema.safeParse(message);
    if (parsed.success) ready.resolve(parsed.data);
    else ready.reject(parsed.error);
  });
  child.on('error', ready.reject);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code, signal });
    });
  });
  const kill = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let receipt: Extract<z.infer<typeof receiptSchema>, { status: 'ready' }>;
  try {
    child.send({
      authorityRegistryPath: options.authorityRegistryPath ?? testAuthorityRegistryPath,
      contentDir,
      configHomedirOverride: home,
      port,
      debounce: options.debounce ?? 200,
      maxDebounce: options.maxDebounce ?? 1000,
      gitEnabled: options.gitEnabled ?? false,
      commitDebounceMs: options.commitDebounceMs ?? 200,
      keepaliveGraceMs: options.keepaliveGraceMs,
    } satisfies RestartWorkerOptions);
    const result = await Promise.race([
      ready.promise,
      exited.then(({ code, signal }) => {
        throw new Error(`Restart server exited before ready (${code}, ${signal})\n${diagnostics}`);
      }),
      new Promise<never>((_, reject) => {
        startupTimer = setTimeout(
          () => reject(new Error(`Restart server startup timed out\n${diagnostics}`)),
          30_000,
        );
      }),
    ]);
    if (result.status === 'error') throw new Error(`${result.message}\n${diagnostics}`);
    if (result.pid !== child.pid || result.port !== port) {
      throw new Error('Restart server receipt does not match its owned child and port');
    }
    receipt = result;
  } catch (error) {
    kill();
    await exited;
    if (options.configHomedirOverride === undefined) removeAllStrictDuringTeardown(home);
    if (options.contentDir === undefined) removeAllStrictDuringTeardown(contentDir);
    throw error;
  } finally {
    if (startupTimer !== undefined) clearTimeout(startupTimer);
  }
  let restarted = false;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (child.exitCode === null && child.signalCode === null) child.send('shutdown');
        const result = await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              kill();
              reject(new Error(`Restart server shutdown timed out\n${diagnostics}`));
            }, 15_000);
          }),
        ]);
        if (result.code !== 0 && result.signal !== 'SIGKILL') {
          throw new Error(
            `Restart server shutdown failed (${result.code}, ${result.signal})\n${diagnostics}`,
          );
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        kill();
        await exited;
        if (options.configHomedirOverride === undefined) removeAllStrictDuringTeardown(home);
        if (!options.keepContentDir && !restarted) removeAllStrictDuringTeardown(contentDir);
      }
    })();
    return shutdownPromise;
  };
  const restart = async (
    mode: 'crash' | 'graceful',
    downtimeMs: number,
  ): Promise<RestartableServer> => {
    restarted = true;
    try {
      if (mode === 'crash') {
        kill();
        await exited;
      }
      await shutdown();
      await wait(downtimeMs);
      return await createRestartableServer({ ...options, contentDir, port });
    } catch (error) {
      try {
        await shutdown();
      } finally {
        if (!options.keepContentDir) removeAllStrictDuringTeardown(contentDir);
      }
      throw error;
    }
  };
  return {
    port,
    contentDir,
    pid: receipt.pid,
    serverInstanceId: receipt.serverInstanceId,
    exited,
    killNetwork: kill,
    disconnectOwner: () => child.disconnect(),
    shutdown,
    killAndRestartOnSamePort({ downtimeMs }) {
      return restart('crash', downtimeMs);
    },
    shutdownAndRestartOnSamePort({ downtimeMs }) {
      return restart('graceful', downtimeMs);
    },
  };
}
