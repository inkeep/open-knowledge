import { fork } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfigPath } from '@inkeep/open-knowledge-core/server';
import { afterEach, describe, expect, test } from 'vitest';

const FIXTURE = fileURLToPath(
  new URL('./test-reset-home-isolation-process.test-helper.ts', import.meta.url),
);
const SAVED_SETTINGS = '{}\n';

type HomeMode = 'isolated' | 'process-home';

interface ResetServer {
  readonly port: number;
  readonly settingsFiles: readonly string[];
  readonly userSettingsFile: string;
  stop(): Promise<void>;
}

const scratchDirs: string[] = [];
const runningServers: ResetServer[] = [];

afterEach(async () => {
  for (const server of runningServers.splice(0)) await server.stop();
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratchDirs.push(dir);
  return dir;
}

function seedSavedSettings(
  contentDir: string,
  home: string,
): Pick<ResetServer, 'settingsFiles' | 'userSettingsFile'> {
  const userSettingsFile = resolveConfigPath('user', contentDir, home);
  const settingsFiles = [
    resolveConfigPath('project', contentDir),
    resolveConfigPath('project-local', contentDir),
    userSettingsFile,
  ];
  for (const file of settingsFiles) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, SAVED_SETTINGS, 'utf-8');
  }
  writeFileSync(join(contentDir, '.ok', '.gitignore'), '', 'utf-8');
  return { settingsFiles, userSettingsFile };
}

async function startResetServer(homeMode: HomeMode): Promise<ResetServer> {
  const contentDir = scratchDir('ok-reset-home-content-');
  const home = scratchDir('ok-reset-home-');
  const seeded = seedSavedSettings(contentDir, home);
  const child = fork(FIXTURE, [contentDir, home, homeMode], {
    execArgv: ['--import', 'tsx', '--conditions=@inkeep/source'],
    silent: true,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, 'config'),
      TMPDIR: home,
      TMP: home,
      TEMP: home,
    },
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdout?.resume();
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  const stop = async () => {
    if (child.connected) child.send('stop');
    await exited;
  };
  const port = await new Promise<number>((resolve, reject) => {
    child.once('message', (message) => {
      if (
        typeof message !== 'object' ||
        message === null ||
        !('port' in message) ||
        typeof message.port !== 'number'
      ) {
        reject(new Error(`The test-reset home fixture sent no port: ${stderr}`));
        return;
      }
      resolve(message.port);
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`The test-reset home fixture exited ${code}: ${stderr}`)),
    );
  });
  const server: ResetServer = { port, ...seeded, stop };
  runningServers.push(server);
  return server;
}

function savedBytes(files: readonly string[]): Record<string, string | null> {
  return Object.fromEntries(
    files.map((file) => [file, existsSync(file) ? readFileSync(file, 'utf-8') : null]),
  );
}

function postServerReset(server: ResetServer): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/test-reset?scope=server`, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
  });
}

describe('a server-scope test reset and the server’s config home', () => {
  test('a server started on the process home refuses a server-scope reset and keeps every saved settings file', async () => {
    const server = await startResetServer('process-home');
    const before = savedBytes(server.settingsFiles);

    const response = await postServerReset(server);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      type: 'urn:ok:error:invalid-request',
      title: 'scope=server needs a server started with an isolated config home.',
    });
    expect(savedBytes(server.settingsFiles)).toEqual(before);
    expect(before[server.userSettingsFile]).toBe(SAVED_SETTINGS);
  }, 60_000);

  test('a server started with an isolated config home admits a server-scope reset and removes the saved user settings', async () => {
    const server = await startResetServer('isolated');
    expect(readFileSync(server.userSettingsFile, 'utf-8')).toBe(SAVED_SETTINGS);

    const response = await postServerReset(server);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scope: 'server' });
    expect(existsSync(server.userSettingsFile)).toBe(false);
  }, 60_000);
});
