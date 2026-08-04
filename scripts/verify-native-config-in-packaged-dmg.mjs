#!/usr/bin/env node
/**
 * Packaged native-config bundle smoke driver.
 *
 * Usage:
 *   node scripts/verify-native-config-in-packaged-dmg.mjs <dmg | app | dir>
 *
 * Proves the prebuilt `native-config` `.node` that the CLI bundles into
 * `dist/native/` actually loads and round-trips from the SHIPPED layout. Unlike
 * the keyring driver (which must launch Electron because the keychain ACL is a
 * macOS-runtime behavior), the toml_edit addon is pure computation over a napi
 * N-API surface that is ABI-stable across Node and Electron, so loading the
 * bundled loader under Node from the packaged path is a faithful check of the
 * bundle + layout + loadability. The remaining in-Electron-process confirmation
 * (hardened runtime, asar) is documented in tests/smoke/native-config-e2e.md and
 * deferred to a signed-DMG QA run.
 *
 * Accepts three input shapes so it runs both pre-package (point it at
 * `packages/cli/dist`) and post-package (a built `.app` or `.dmg`):
 *   - a directory holding the bundle (`<dir>`, `<dir>/native`, `<dir>/dist/native`,
 *     or `<dir>/cli/dist/native`);
 *   - an `.app` bundle (`<app>/Contents/Resources/cli/dist/native`);
 *   - a `.dmg` (mounted read-only, the first `.app` inside is resolved, detached).
 *
 * Exit codes:
 *   0 — the bundled addon loaded and round-tripped its parse/upsert/symlink surface
 *   1 — the addon was found but failed to load or round-trip
 *   2 — bad arguments
 *   3 — no bundled `dist/native` (loader) found in the input
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Candidate sub-paths under a directory input that may hold the napi loader. */
const DIR_CANDIDATES = ['.', 'native', 'dist/native', 'cli/dist/native'];

/** Where the electron-builder `from: ../cli/dist` rule lands the bundle in a `.app`. */
const APP_BUNDLE_SUBPATH = ['Contents', 'Resources', 'cli', 'dist', 'native'];

/**
 * Parse CLI args — single positional (dmg, app, or dir). Exported for tests.
 */
export function parseArgs(argv) {
  const positional = argv.slice(2).filter((a) => !a.startsWith('-'));
  if (positional.length !== 1 || !positional[0]) {
    throw new Error('Usage: verify-native-config-in-packaged-dmg.mjs <dmg | app | dir>');
  }
  return { inputPath: positional[0] };
}

/**
 * Classify the input path as `.dmg`, `.app`, or a plain directory. Exported for
 * tests.
 */
export function classifyInputPath(p) {
  const lower = p.toLowerCase();
  if (lower.endsWith('.dmg')) return 'dmg';
  if (lower.endsWith('.app')) return 'app';
  return 'dir';
}

/**
 * Resolve the directory that holds the napi loader (`index.js` + the platform
 * `.node`) inside a plain directory input. Returns null when none of the known
 * layouts contains a loader. Exported for tests.
 */
export function resolveBundledNativeDirInDir(dirPath, deps = {}) {
  const exists = deps.existsSync ?? existsSync;
  for (const candidate of DIR_CANDIDATES) {
    const dir = resolve(dirPath, candidate);
    if (exists(join(dir, 'index.js'))) return dir;
  }
  return null;
}

/**
 * Load the bundled addon from `nativeDir` and round-trip its full JS-facing
 * surface (parse, insert-only upsert, symlink resolution). Returns a structured
 * result. `deps.requireModule` is injectable so a test can drive the outcome
 * without a real `.node`.
 */
export function loadAndRoundTrip(nativeDir, deps = {}) {
  const requireModule = deps.requireModule ?? createRequire(import.meta.url);
  const now = deps.now ?? Date.now;
  const start = now();
  try {
    const mod = requireModule(join(nativeDir, 'index.js'));

    const parsed = JSON.parse(mod.parseTomlToJson('probe = 1'));
    if (parsed.probe !== 1) throw new Error('parseTomlToJson did not round-trip a scalar');

    const upsert = mod.upsertMcpServer('', 'open-knowledge', JSON.stringify({ command: 'probe' }));
    if (typeof upsert.text !== 'string') throw new Error('upsertMcpServer returned no text');

    const symlink = mod.resolveSymlinkWritePath(join(nativeDir, 'index.js'));
    if (typeof symlink.writePath !== 'string') {
      throw new Error('resolveSymlinkWritePath returned no writePath');
    }

    return { ok: true, backend: 'native', nativeDir, durationMs: now() - start };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err), nativeDir };
  }
}

/**
 * Resolve a `.dmg`/`.app`/dir input to the bundled native dir plus a cleanup
 * handle. For `.dmg`, mount read-only, copy the first `.app` to a tmp dir,
 * detach, and resolve the app layout inside the copy.
 */
async function resolveNativeDir(inputPath, kind, deps = {}) {
  const exists = deps.existsSync ?? existsSync;

  if (kind === 'dir') {
    const nativeDir = resolveBundledNativeDirInDir(inputPath, deps);
    return { nativeDir, cleanup: async () => {} };
  }

  if (kind === 'app') {
    const nativeDir = resolve(inputPath, ...APP_BUNDLE_SUBPATH);
    return { nativeDir: exists(join(nativeDir, 'index.js')) ? nativeDir : null, cleanup: async () => {} };
  }

  // kind === 'dmg'
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const mkdtempImpl = deps.mkdtemp ?? mkdtemp;
  const cpImpl = deps.cp ?? cp;
  const rmImpl = deps.rm ?? rm;
  const listAppsInMount = deps.listAppsInMount ?? defaultListAppsInMount;

  const abs = resolve(inputPath);
  const mountRoot = await mkdtempImpl(join(tmpdir(), 'ok-nc-mount-'));
  const appCopyRoot = await mkdtempImpl(join(tmpdir(), 'ok-nc-app-'));
  let detached = false;
  const detach = async () => {
    if (detached) return;
    detached = true;
    try {
      await runCommand('hdiutil', ['detach', '-quiet', mountRoot]);
    } catch {
      // best effort
    }
  };
  try {
    await runCommand('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountRoot, abs]);
    const apps = await listAppsInMount(mountRoot);
    if (apps.length === 0) throw new Error(`No .app bundle found in mounted DMG: ${abs}`);
    const appCopyPath = join(appCopyRoot, apps[0]);
    await cpImpl(join(mountRoot, apps[0]), appCopyPath, { recursive: true });
    await detach();
    const nativeDir = resolve(appCopyPath, ...APP_BUNDLE_SUBPATH);
    return {
      nativeDir: exists(join(nativeDir, 'index.js')) ? nativeDir : null,
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

/**
 * End-to-end orchestration. Returns the exit code for the driver process.
 * Exported so tests can assert exit-code behavior without the shebang entry.
 */
export async function runDriver(argv, deps = {}) {
  const writeStream = deps.writeStream ?? ((s) => process.stdout.write(s));
  const errStream = deps.errStream ?? ((s) => process.stderr.write(s));

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    errStream(`${err.message}\n`);
    return 2;
  }

  let resolved;
  try {
    const kind = classifyInputPath(args.inputPath);
    resolved = await resolveNativeDir(args.inputPath, kind, deps);

    if (!resolved.nativeDir) {
      errStream(
        `verify-native-config: no bundled native loader (dist/native/index.js) found in ${args.inputPath}. ` +
          'Build the CLI (`bun run build`) so packages/cli/dist/native/ exists, or point at a packaged .app/.dmg.\n',
      );
      return 3;
    }

    const result = (deps.loadAndRoundTrip ?? loadAndRoundTrip)(resolved.nativeDir, deps);
    if (result.ok) {
      writeStream(
        `verify-native-config: OK — backend=${result.backend} nativeDir=${result.nativeDir} durationMs=${result.durationMs ?? '?'}\n`,
      );
      return 0;
    }

    errStream(
      `verify-native-config: bundled addon failed to load/round-trip from ${result.nativeDir} — ${result.error}\n`,
    );
    return 1;
  } catch (err) {
    errStream(`verify-native-config: driver error — ${err.message}\n`);
    return 1;
  } finally {
    await resolved?.cleanup().catch(() => {});
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

// Shebang entry — run the driver when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  runDriver(process.argv).then((code) => process.exit(code));
}
