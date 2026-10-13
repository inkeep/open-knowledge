import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  APP_DIR,
  makeRunDir,
  type OwnerConfig,
  startResourceOwner,
} from './owner-launch.test-helper.ts';

export const FAILED_SPAWN_COMMANDS = {
  'dev-server': ['run', 'dev', '--host', '127.0.0.1'],
  prebuilt: ['exec', 'vite', 'preview', '--config', 'vite.prebuilt-dev.ts', '--host', '127.0.0.1'],
} as const;

export type FailedSpawnMode = keyof typeof FAILED_SPAWN_COMMANDS;
export type FailedSpawnBackend = 'exported' | 'native';

const terminalSchema = z.object({
  code: z.number().nullable(),
  signal: z.string().nullable(),
});
const errorSchema = z.object({
  name: z.string(),
  message: z.string(),
  errno: z.number().optional(),
  code: z.string().optional(),
  syscall: z.string().optional(),
  path: z.string().optional(),
  spawnargs: z.array(z.string()).optional(),
});
const afterErrorSchema = z.object({
  exitCode: z.number().nullable(),
  signalCode: z.string().nullable(),
});
const contractSchema = z.object({
  error: errorSchema,
  afterError: afterErrorSchema,
  exits: z.array(terminalSchema),
  close: terminalSchema,
});
const resourcesSchema = z.object({
  contentDir: z.string(),
  viteCacheDir: z.string(),
  receiptDir: z.string(),
  logPath: z.string(),
  emptyPath: z.string(),
});
export const failedSpawnObservationSchema = z.object({
  mode: z.enum(['dev-server', 'prebuilt']),
  backend: z.enum(['exported', 'native']),
  node: z.string(),
  resources: resourcesSchema,
  contract: contractSchema,
  at: z.number(),
});

export function failedSpawnOwnerConfig(
  mode: FailedSpawnMode,
  backend: FailedSpawnBackend,
  ending: 'complete' | 'hold' = 'complete',
): OwnerConfig {
  const run = makeRunDir(`spawn-error-${mode}-${backend}-${ending}`);
  return {
    ...run,
    cwd: APP_DIR,
    args: [fileURLToPath(import.meta.url), 'actor', mode, backend, ending, run.dir],
    environment: {},
    deadlineMs: 30_000,
  };
}

export function readFailedSpawnObservation(dir: string) {
  return failedSpawnObservationSchema.parse(
    JSON.parse(readFileSync(join(dir, 'spawn-error-result.json'), 'utf8')),
  );
}

export async function observeWorkerSpawnError(mode: FailedSpawnMode, backend: FailedSpawnBackend) {
  const config = failedSpawnOwnerConfig(mode, backend);
  const owner = startResourceOwner(config);
  try {
    const exit = await owner.subjectExit;
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(
        `failed-spawn observation ended before its result: ${JSON.stringify(exit)}; ${config.dir}`,
      );
    }
    const observation = readFailedSpawnObservation(config.dir);
    const cleanup = await owner.release();
    return { observation, cleanup, exit, dir: config.dir };
  } finally {
    await owner.release();
  }
}

async function runFailedSpawnActor(
  mode: FailedSpawnMode,
  backend: FailedSpawnBackend,
  ending: 'complete' | 'hold',
  dir: string,
): Promise<void> {
  const fixture = await import('../../stress/_helpers/fixtures.ts');
  const {
    closeServerLog,
    createViteStartupRequest,
    killGracefully: killNative,
    openServerLog,
    prepareViteCacheDir,
  } = await import('../../stress/_helpers/server-process.ts');
  const { completeWorkerServerRelease, stopWorkerServer } = await import(
    '../../stress/_helpers/worker-server-lifetime.ts'
  );
  const { removeAllDuringTeardown, runTeardownPhases } = await import(
    '../../stress/_helpers/teardown-fs.ts'
  );
  const request = createViteStartupRequest('127.0.0.1');
  const contentDir = mkdtempSync(join(tmpdir(), 'ok-w412-spawn-error-'));
  const viteCacheDir = prepareViteCacheDir('w412');
  const serverLog = openServerLog('w412-spawn-error');
  const emptyPath = join(contentDir, 'empty-bin');
  mkdirSync(emptyPath);
  const outputDir = join(contentDir, 'prebuilt');
  if (mode === 'prebuilt') {
    const { prebuiltManifest } = await import('../test-server-inputs.ts');
    const { PREBUILT_BUILD_OPTIONS, PREBUILT_MANIFEST_FILE } = await import(
      '../../stress/_helpers/prebuilt/prebuilt-serving.ts'
    );
    mkdirSync(outputDir);
    writeFileSync(
      join(outputDir, PREBUILT_MANIFEST_FILE),
      JSON.stringify(prebuiltManifest(join(APP_DIR, '..', '..'), PREBUILT_BUILD_OPTIONS)),
    );
  }
  const workerProc =
    backend === 'native'
      ? undefined
      : fixture.spawnWorkerDevServer(
          request,
          { PATH: emptyPath },
          contentDir,
          viteCacheDir,
          serverLog,
          mode === 'prebuilt' ? { kind: 'prebuilt', outputDir } : { kind: 'dev-server' },
        );
  const proc: ChildProcess =
    workerProc ??
    spawn('pnpm', [...FAILED_SPAWN_COMMANDS[mode]], {
      cwd: APP_DIR,
      env: { ...process.env, PATH: emptyPath },
      stdio: ['ignore', serverLog.fd, 'inherit'],
    });
  const exits: Array<z.infer<typeof terminalSchema>> = [];
  proc.on('exit', (code, signal) => exits.push({ code, signal }));
  const closed = new Promise<z.infer<typeof terminalSchema>>((resolve) =>
    proc.once('close', (code, signal) => resolve({ code, signal })),
  );
  const resources = {
    contentDir,
    viteCacheDir,
    receiptDir: request.receiptDir,
    logPath: serverLog.path,
    emptyPath,
  };
  let error: z.infer<typeof errorSchema>;
  let afterError: z.infer<typeof afterErrorSchema>;
  try {
    const nativeError = await new Promise<Error>((resolve) => proc.once('error', resolve));
    error = errorSchema.parse(nativeError);
    afterError = { exitCode: proc.exitCode, signalCode: proc.signalCode };
    writeFileSync(
      join(dir, 'spawn-error-ready.json'),
      JSON.stringify({ mode, backend, error, afterError, resources, at: Date.now() }),
    );
    if (ending === 'hold') {
      await new Promise<never>(() => setInterval(() => undefined, 1_000));
    }
  } finally {
    await runTeardownPhases(
      () =>
        workerProc === undefined ? killNative(proc, 5_000) : stopWorkerServer(workerProc, 5_000),
      () => {
        closeServerLog(serverLog);
        removeAllDuringTeardown(contentDir, viteCacheDir, request.receiptDir, serverLog.path);
      },
      () => (workerProc === undefined ? undefined : completeWorkerServerRelease(workerProc)),
    );
  }
  writeFileSync(
    join(dir, 'spawn-error-result.json'),
    `${JSON.stringify({ mode, backend, node: process.version, resources, contract: { error, afterError, exits, close: await closed }, at: Date.now() }, null, 2)}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , role, mode, backend, ending, dir] = process.argv;
  if (
    role !== 'actor' ||
    (mode !== 'dev-server' && mode !== 'prebuilt') ||
    (backend !== 'exported' && backend !== 'native') ||
    (ending !== 'complete' && ending !== 'hold') ||
    dir === undefined
  ) {
    throw new Error('failed-spawn actor requires its recorded mode, backend, ending and directory');
  }
  await runFailedSpawnActor(mode, backend, ending, dir);
}
