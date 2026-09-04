import { spawn } from 'node:child_process';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const MOUNT_ERROR_CODES = {
  attachFailed: 'dmg-attach-failed',
  noAppBundle: 'dmg-no-app-bundle',
};

export class DmgMountError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DmgMountError';
    this.code = code;
  }
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
  const entries = await readdir(mountPath);
  return entries.filter((e) => e.toLowerCase().endsWith('.app'));
}

export async function withMountedDmg(dmgPath, callback, deps = {}) {
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const mkdtempImpl = deps.mkdtemp ?? mkdtemp;
  const cpImpl = deps.cp ?? cp;
  const rmImpl = deps.rm ?? rm;
  const listAppsInMount = deps.listAppsInMount ?? defaultListAppsInMount;
  const proc = deps.process ?? process;

  const abs = resolve(dmgPath);
  const mountRoot = await mkdtempImpl(join(tmpdir(), 'ok-dmg-mount-'));
  const appCopyRoot = await mkdtempImpl(join(tmpdir(), 'ok-dmg-app-'));

  const warn = deps.warn ?? ((msg) => process.stderr.write(`[dmg-mount] ${msg}\n`));
  const describe = (err) => err?.message ?? String(err);

  let detached = false;
  const detach = async () => {
    if (detached) return;
    detached = true;
    try {
      await runCommand('hdiutil', ['detach', '-quiet', mountRoot]);
    } catch (err) {
      warn(`hdiutil detach failed for ${mountRoot}: ${describe(err)}`);
    }
  };

  const removeScratch = async () => {
    await rmImpl(appCopyRoot, { recursive: true, force: true }).catch((err) => {
      warn(`could not remove ${appCopyRoot}: ${describe(err)}`);
    });
    await rmImpl(mountRoot, { recursive: true, force: true }).catch((err) => {
      warn(`could not remove ${mountRoot}: ${describe(err)}`);
    });
  };

  let signalHandled = false;
  async function signalCleanupAndExit(exitCode) {
    if (signalHandled) return;
    signalHandled = true;
    try {
      await detach();
      await removeScratch();
    } finally {
      proc.exit(exitCode);
    }
  }
  const sigintHandler = () => {
    void signalCleanupAndExit(130);
  };
  const sigtermHandler = () => {
    void signalCleanupAndExit(143);
  };
  proc.once('SIGINT', sigintHandler);
  proc.once('SIGTERM', sigtermHandler);

  try {
    try {
      await runCommand('hdiutil', [
        'attach',
        '-nobrowse',
        '-readonly',
        '-mountpoint',
        mountRoot,
        abs,
      ]);
    } catch (err) {
      throw new DmgMountError(
        `hdiutil attach failed for ${abs}: ${err?.message ?? String(err)}`,
        MOUNT_ERROR_CODES.attachFailed,
      );
    }

    const apps = await listAppsInMount(mountRoot);
    if (apps.length === 0) {
      await detach();
      throw new DmgMountError(
        `No .app bundle found in mounted DMG: ${abs}`,
        MOUNT_ERROR_CODES.noAppBundle,
      );
    }

    const appName = apps[0];
    const appCopyPath = join(appCopyRoot, appName);
    await cpImpl(join(mountRoot, appName), appCopyPath, {
      recursive: true,
      verbatimSymlinks: true,
    });
    await detach();

    return await callback(appCopyPath);
  } finally {
    proc.removeListener('SIGINT', sigintHandler);
    proc.removeListener('SIGTERM', sigtermHandler);
    await detach();
    await removeScratch();
  }
}
