/**
 * Shared hdiutil mount/copy/detach primitive for packaged-DMG drivers.
 *
 * `withMountedDmg` attaches a `.dmg` read-only, copies the first `.app` bundle
 * out to a temporary directory, detaches the mount, and only then hands the
 * COPIED bundle to the caller. Launching from the copy rather than the live
 * mount is the whole point: a packaged smoke run holds the app open for
 * minutes, and a mount held for that window is what strands `/Volumes` entries
 * when CI kills the run.
 *
 * SIGINT/SIGTERM are handled explicitly because Node's default on both is a
 * synchronous exit that skips `finally` — which would leave the volume attached
 * until someone runs `hdiutil detach` by hand or reboots the runner. Handlers
 * are registered per invocation and removed in `finally` so a long-lived
 * process that mounts repeatedly does not accumulate listeners.
 *
 * Every external effect is injectable via `deps` so the colocated test covers
 * each branch without invoking real hdiutil.
 */

import { spawn } from 'node:child_process';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Discriminants for the two ways a mount can fail structurally. Callers map
 * these to an infrastructure verdict rather than a product verdict — a DMG that
 * cannot be mounted says nothing about whether the app works.
 */
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

/**
 * Mount `dmgPath`, copy its first `.app` out, detach, then invoke `callback`
 * with the path to the copied bundle. The copy and the mountpoint are removed
 * before returning, whether the callback resolved or threw.
 *
 * Returns whatever `callback` returns.
 */
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

  // `defaultRunCommand` spawns with stdio: 'pipe', so hdiutil's stderr lands in
  // the Error message rather than the terminal. Swallowing these errors without
  // logging leaves a stranded /Volumes entry — or an orphaned ~200MB .app copy —
  // with no breadcrumb, which on a long-lived runner surfaces much later as an
  // "already mounted" or disk-full failure with no trail back to here.
  const warn = deps.warn ?? ((msg) => process.stderr.write(`[dmg-mount] ${msg}\n`));
  const describe = (err) => err?.message ?? String(err);

  let detached = false;
  const detach = async () => {
    if (detached) return;
    detached = true;
    try {
      await runCommand('hdiutil', ['detach', '-quiet', mountRoot]);
    } catch (err) {
      // Log, don't throw: throwing here would mask whichever error sent us
      // into cleanup.
      warn(`hdiutil detach failed for ${mountRoot}: ${describe(err)}`);
    }
  };

  const removeScratch = async () => {
    // `force: true` already absorbs ENOENT; what reaches these handlers is
    // EPERM / EBUSY / read-only-filesystem, all worth a line.
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
    await cpImpl(join(mountRoot, appName), appCopyPath, { recursive: true });
    await detach();

    return await callback(appCopyPath);
  } finally {
    proc.removeListener('SIGINT', sigintHandler);
    proc.removeListener('SIGTERM', sigtermHandler);
    await detach();
    await removeScratch();
  }
}
