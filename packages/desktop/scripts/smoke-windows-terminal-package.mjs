#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SPAWN_STARTUP_DEADLINE_MS,
  SPAWN_WAIT_EXTENSION_FACTOR,
} from '../src/shared/boot-narration.ts';

export const PACKAGED_BOOT_ENVELOPE_MS = 10_000;
export const PACKAGED_PTY_ECHO_BUDGET_MS = 30_000;
export const PACKAGED_DISCOVERY_OVERRUN_MS = 3_000;
export const PACKAGED_DRIVER_MARGIN_MS = 5_000;

export function packagedStartupBoundMs(
  spawnStartupDeadlineMs = SPAWN_STARTUP_DEADLINE_MS,
  spawnWaitExtensionFactor = SPAWN_WAIT_EXTENSION_FACTOR,
) {
  return spawnStartupDeadlineMs * spawnWaitExtensionFactor;
}

export function packagedDiscoveryDeadlineMs(
  spawnStartupDeadlineMs = SPAWN_STARTUP_DEADLINE_MS,
  spawnWaitExtensionFactor = SPAWN_WAIT_EXTENSION_FACTOR,
) {
  return (
    packagedStartupBoundMs(spawnStartupDeadlineMs, spawnWaitExtensionFactor) +
    PACKAGED_BOOT_ENVELOPE_MS
  );
}

export const PACKAGED_DRIVER_TIMEOUT_MS =
  packagedDiscoveryDeadlineMs() +
  PACKAGED_PTY_ECHO_BUDGET_MS +
  PACKAGED_DISCOVERY_OVERRUN_MS +
  PACKAGED_DRIVER_MARGIN_MS;

export function describeDriverTimeoutBudget() {
  return (
    `the packaged PTY CDP driver outlived its ${PACKAGED_DRIVER_TIMEOUT_MS / 1000}s budget ` +
    `(${packagedDiscoveryDeadlineMs() / 1000}s discovery + ${PACKAGED_PTY_ECHO_BUDGET_MS / 1000}s echo + ` +
    `${PACKAGED_DISCOVERY_OVERRUN_MS / 1000}s overrun + ${PACKAGED_DRIVER_MARGIN_MS / 1000}s margin), ` +
    'so one phase overran and was killed before it could report itself'
  );
}

export function packagedDriverSpawnOptions(packageDir, env = process.env) {
  return {
    cwd: packageDir,
    encoding: 'utf8',
    env: windowsPtyDriverEnv(env),
    timeout: PACKAGED_DRIVER_TIMEOUT_MS,
  };
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultPackageDir = resolve(scriptDir, '../dist-desktop/win-unpacked');
const cdpDriver = join(scriptDir, 'smoke-terminal-package-cdp.py');

export function windowsPackageLaunchArgs(projectDir, userDataDir) {
  const project = encodeURIComponent(projectDir);
  return [
    '--disable-gpu',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=9222',
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    `openknowledge://open?project=${project}&doc=start`,
  ];
}

export function windowsPtyDriverEnv(env = process.env) {
  return {
    ...env,
    OK_SMOKE_EXPECT_PLATFORM: 'win32',
    OK_SMOKE_DISCOVERY_DEADLINE_MS: String(packagedDiscoveryDeadlineMs()),
    OK_SMOKE_ECHO_DEADLINE_MS: String(PACKAGED_PTY_ECHO_BUDGET_MS),
  };
}

export function seedWindowsPtySmokeProject(rootDir, shellPath) {
  const projectDir = join(rootDir, 'project');
  const userDataDir = join(rootDir, 'user-data');
  mkdirSync(join(projectDir, '.ok', 'local'), { recursive: true });
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(join(projectDir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
  writeFileSync(
    join(projectDir, '.ok', 'local', 'config.yml'),
    `terminal:\n  enabled: true\n  shell: ${JSON.stringify(shellPath.trim())}\n`,
  );
  writeFileSync(join(projectDir, 'start.md'), '# Packaged Windows terminal smoke\n');
  return { projectDir, userDataDir };
}

function fail(message) {
  throw new Error(message);
}

function printAppLog(logPath) {
  if (!existsSync(logPath)) return;
  const contents = readFileSync(logPath, 'utf8');
  const tail = contents.slice(-20_000);
  if (tail.trim() !== '') console.error(`Packaged app log (tail):\n${tail}`);
}

export function runWindowsPackageTerminalSmoke({
  packageDir = defaultPackageDir,
  platform = process.platform,
  env = process.env,
  python = env.OK_PYTHON ?? 'python',
} = {}) {
  if (platform !== 'win32') fail('the packaged Windows PTY smoke must run on Windows');
  const shellPath = env.ComSpec;
  if (typeof shellPath !== 'string' || shellPath.trim() === '') {
    fail('the packaged Windows PTY smoke requires ComSpec in its environment');
  }

  const resolvedPackageDir = resolve(packageDir);
  const executable = join(resolvedPackageDir, 'OpenKnowledge.exe');
  if (!existsSync(executable)) fail(`packaged executable not found: ${executable}`);

  const smokeRoot = mkdtempSync(join(tmpdir(), 'ok-packaged-win-pty-'));
  const logPath = join(smokeRoot, 'openknowledge.log');
  const { projectDir, userDataDir } = seedWindowsPtySmokeProject(smokeRoot, shellPath);
  const logFd = openSync(logPath, 'w');
  let app = null;

  try {
    app = spawn(executable, windowsPackageLaunchArgs(projectDir, userDataDir), {
      cwd: resolvedPackageDir,
      env: { ...env, OK_DESKTOP_E2E_SMOKE: '1' },
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });

    const driver = spawnSync(
      python,
      [cdpDriver],
      packagedDriverSpawnOptions(resolvedPackageDir, env),
    );
    if (driver.stdout) process.stdout.write(driver.stdout);
    if (driver.stderr) process.stderr.write(driver.stderr);
    if (driver.error?.code === 'ETIMEDOUT') {
      fail(describeDriverTimeoutBudget());
    }
    if (driver.error) fail(`could not run packaged PTY CDP driver: ${driver.error.message}`);
    if (driver.status !== 0) {
      fail(`packaged PTY CDP driver exited ${driver.status} (signal ${driver.signal})`);
    }
  } catch (error) {
    closeSync(logFd);
    printAppLog(logPath);
    throw error;
  } finally {
    if (app?.pid) {
      spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    }
    try {
      closeSync(logFd);
    } catch {}
    try {
      rmSync(smokeRoot, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Could not remove packaged PTY smoke fixture ${smokeRoot}: ${error.message}`);
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    runWindowsPackageTerminalSmoke({ packageDir: process.argv[2] ?? defaultPackageDir });
    console.log('Packaged Windows PTY CDP round-trip passed.');
  } catch (error) {
    console.error(`ERROR: ${(error instanceof Error ? error : new Error(String(error))).message}`);
    process.exitCode = 1;
  }
}
