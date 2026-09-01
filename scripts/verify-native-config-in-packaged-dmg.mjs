#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DIR_CANDIDATES = ['.', 'native', 'dist/native', 'cli/dist/native'];

const APP_BUNDLE_SUBPATH = ['Contents', 'Resources', 'cli', 'dist', 'native'];

export function parseArgs(argv) {
  const positional = argv.slice(2).filter((a) => !a.startsWith('-'));
  if (positional.length !== 1 || !positional[0]) {
    throw new Error('Usage: verify-native-config-in-packaged-dmg.mjs <dmg | app | dir>');
  }
  return { inputPath: positional[0] };
}

export function classifyInputPath(p) {
  const lower = p.toLowerCase();
  if (lower.endsWith('.dmg')) return 'dmg';
  if (lower.endsWith('.app')) return 'app';
  return 'dir';
}

export function resolveBundledNativeDirInDir(dirPath, deps = {}) {
  const exists = deps.existsSync ?? existsSync;
  for (const candidate of DIR_CANDIDATES) {
    const dir = resolve(dirPath, candidate);
    if (exists(join(dir, 'index.js'))) return dir;
  }
  return null;
}

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

if (import.meta.url === `file://${process.argv[1]}`) {
  runDriver(process.argv).then((code) => process.exit(code));
}
