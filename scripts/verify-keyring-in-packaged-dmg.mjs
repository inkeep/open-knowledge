#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const DEFAULT_TIMEOUT_MS = 30_000;
const STDERR_TAIL_LINES = 40;
const KILL_ESCALATION_GRACE_MS = 2_000;

export function parseArgs(argv) {
  const positional = argv.slice(2).filter((a) => !a.startsWith('-'));
  if (positional.length !== 1 || !positional[0]) {
    throw new Error('Usage: verify-keyring-in-packaged-dmg.mjs <dmg-path | app-path>');
  }
  return { inputPath: positional[0] };
}

export function classifyInputPath(p) {
  const lower = p.toLowerCase();
  if (lower.endsWith('.dmg')) return 'dmg';
  if (lower.endsWith('.app')) return 'app';
  throw new Error(`Input must be a .dmg or .app path; got: ${p}`);
}

async function resolveAppPath(inputPath, deps = {}) {
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const mkdtempImpl = deps.mkdtemp ?? mkdtemp;
  const cpImpl = deps.cp ?? cp;
  const rmImpl = deps.rm ?? rm;
  const listAppsInMount = deps.listAppsInMount ?? defaultListAppsInMount;

  const abs = resolve(inputPath);
  const kind = classifyInputPath(abs);
  if (kind === 'app') {
    return { appPath: abs, kind, cleanup: async () => {} };
  }

  const mountRoot = await mkdtempImpl(join(tmpdir(), 'ok-dmg-mount-'));
  const appCopyRoot = await mkdtempImpl(join(tmpdir(), 'ok-app-copy-'));
  let detached = false;
  const detach = async () => {
    if (detached) return;
    detached = true;
    try {
      await runCommand('hdiutil', ['detach', '-quiet', mountRoot]);
    } catch {
    }
  };
  try {
    await runCommand('hdiutil', [
      'attach',
      '-nobrowse',
      '-readonly',
      '-mountpoint',
      mountRoot,
      abs,
    ]);
    const apps = await listAppsInMount(mountRoot);
    if (apps.length === 0) {
      throw new Error(`No .app bundle found in mounted DMG: ${abs}`);
    }
    const appName = apps[0];
    const appCopyPath = join(appCopyRoot, appName);
    await cpImpl(join(mountRoot, appName), appCopyPath, { recursive: true });
    await detach();
    return {
      appPath: appCopyPath,
      kind,
      cleanup: async () => {
        await detach();
        await rmImpl(appCopyRoot, { recursive: true, force: true });
        await rmImpl(mountRoot, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await detach();
    await rmImpl(appCopyRoot, { recursive: true, force: true }).catch(() => {});
    await rmImpl(mountRoot, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function spawnAppWithEnv(appPath, outPath, deps = {}) {
  const spawnImpl = deps.spawn ?? spawn;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const killEscalationMs = deps.killEscalationMs ?? KILL_ESCALATION_GRACE_MS;
  const setTimeoutImpl = deps.setTimeout ?? setTimeout;
  const clearTimeoutImpl = deps.clearTimeout ?? clearTimeout;

  const execPath = await resolveExecutable(appPath, deps);
  const child = spawnImpl(execPath, [], {
    env: {
      ...process.env,
      OK_DEBUG_KEYRING_SMOKE: '1',
      OK_DEBUG_KEYRING_SMOKE_EXIT: '1',
      OK_DEBUG_KEYRING_SMOKE_OUT: outPath,
      ELECTRON_ENABLE_LOGGING: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderrChunks = [];
  child.stderr?.on('data', (d) => {
    stderrChunks.push(d.toString('utf-8'));
  });

  return await new Promise((resolvePromise) => {
    let settled = false;
    let sigkillTimer = null;
    const settle = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timer);
      if (sigkillTimer) clearTimeoutImpl(sigkillTimer);
      resolvePromise({ exitCode, stderr: stderrChunks.join('') });
    };
    const timer = setTimeoutImpl(() => {
      try {
        child.kill('SIGTERM');
      } catch {
      }
      sigkillTimer = setTimeoutImpl(() => {
        try {
          child.kill('SIGKILL');
        } catch {
        }
        settle(null);
      }, killEscalationMs);
    }, timeoutMs);
    child.on('exit', (code) => settle(code));
    child.on('error', () => settle(null));
  });
}

async function resolveExecutable(appPath, deps = {}) {
  const statImpl = deps.stat ?? stat;
  const exec = join(appPath, 'Contents', 'MacOS', basename(appPath, '.app'));
  try {
    await statImpl(exec);
    return exec;
  } catch {
    throw new Error(`Executable not found at ${exec}`);
  }
}

export async function readSmokeResult(outPath, deps = {}) {
  const readFileImpl = deps.readFile ?? readFile;
  try {
    const contents = await readFileImpl(outPath, 'utf-8');
    return JSON.parse(contents);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function runDriver(argv, deps = {}) {
  const writeStream = deps.writeStream ?? ((s) => process.stdout.write(s));
  const errStream = deps.errStream ?? ((s) => process.stderr.write(s));
  const mkdtempImpl = deps.mkdtemp ?? mkdtemp;
  const rmImpl = deps.rm ?? rm;
  const proc = deps.process ?? process;

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    errStream(`${err.message}\n`);
    return 2;
  }

  let resolvedApp;
  let outDir;

  let signalHandled = false;
  async function signalCleanupAndExit(signal, exitCode) {
    if (signalHandled) return;
    signalHandled = true;
    errStream(`verify-keyring: received ${signal}, cleaning up…\n`);
    try {
      await resolvedApp?.cleanup().catch(() => {});
      if (outDir) await rmImpl(outDir, { recursive: true, force: true }).catch(() => {});
    } finally {
      proc.exit(exitCode);
    }
  }
  const sigintHandler = () => {
    void signalCleanupAndExit('SIGINT', 130);
  };
  const sigtermHandler = () => {
    void signalCleanupAndExit('SIGTERM', 143);
  };
  proc.once('SIGINT', sigintHandler);
  proc.once('SIGTERM', sigtermHandler);

  try {
    resolvedApp = await resolveAppPath(args.inputPath, deps);
    outDir = await mkdtempImpl(join(tmpdir(), 'ok-smoke-out-'));
    const outPath = join(outDir, 'smoke.json');

    const { exitCode, stderr } = await spawnAppWithEnv(resolvedApp.appPath, outPath, deps);

    if (exitCode === null) {
      errStream('verify-keyring: app did not exit within timeout.\n');
      errStream(formatStderrTail(stderr));
      return 2;
    }

    const result = await readSmokeResult(outPath, deps);
    if (!result) {
      errStream(
        'verify-keyring: smoke result file never appeared. Either the app ' +
          'exited before the smoke finished, or the smoke completed but the ' +
          "output write failed — check the parent dir's permissions on the " +
          'OUT path and the stderr tail below.\n',
      );
      errStream(formatStderrTail(stderr));
      return 3;
    }

    if (result.ok === true) {
      writeStream(
        `verify-keyring: OK — backend=${result.backend ?? 'unknown'} durationMs=${result.durationMs ?? '?'}\n`,
      );
      return 0;
    }

    errStream(`verify-keyring: smoke reported failure — ${result.error ?? '(no error message)'}\n`);
    errStream(formatStderrTail(stderr));
    return 1;
  } catch (err) {
    errStream(`verify-keyring: driver error — ${err.message}\n`);
    return 1;
  } finally {
    proc.removeListener('SIGINT', sigintHandler);
    proc.removeListener('SIGTERM', sigtermHandler);
    await resolvedApp?.cleanup().catch(() => {});
    if (outDir) await rmImpl(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

function formatStderrTail(stderr) {
  if (!stderr) return '';
  const lines = stderr.split('\n').slice(-STDERR_TAIL_LINES);
  return `--- stderr tail (${lines.length} lines) ---\n${lines.join('\n')}\n`;
}

async function defaultRunCommand(cmd, args) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { stdio: 'pipe' });
    const stderrBuf = [];
    child.stderr?.on('data', (d) => stderrBuf.push(d.toString('utf-8')));
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${cmd} exited ${code}: ${stderrBuf.join('').trim()}`));
    });
    child.on('error', (err) => rejectPromise(err));
  });
}

async function defaultListAppsInMount(mountPath) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(mountPath);
  return entries.filter((e) => e.toLowerCase().endsWith('.app'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runDriver(process.argv).then((code) => process.exit(code));
}
