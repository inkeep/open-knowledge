#!/usr/bin/env node
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Make node-pty's prebuilt `spawn-helper` executable.
 *
 * node-pty ships prebuilt binaries under
 * `node-pty/prebuilds/<platform>-<arch>/{pty.node,spawn-helper}`, and the
 * prebuilt `spawn-helper` is mode 0644 — not executable (node-pty#850). Both
 * producers that lay it on disk preserve that non-executable mode — `bun install`
 * for the dev tree, electron-builder's asarUnpack for the packed app — so
 * `pty.fork()` dies at runtime with "posix_spawnp failed" and the in-app terminal
 * never spawns a shell.
 *
 * Two call sites re-enforce the executable bit, sharing one chmod primitive:
 *   - PACKAGED (`ensureNodePtySpawnHelperExecutable`) — afterPack, against the
 *     packed `Contents/Resources/app.asar.unpacked/.../prebuilds` tree, before
 *     electron-builder re-signs (the Developer ID signature covers the +x bit).
 *   - DEV / CI (`ensureNodePtySpawnHelperExecutableInNodeModules`) — the desktop
 *     postinstall, against the real `node_modules/node-pty/prebuilds` tree, so
 *     `bun run build:desktop` / `dev:electron` / smoke launches get a working
 *     terminal without packaging.
 *
 * We ship arm64-only (mac.target), so the darwin-arm64 helper is load-bearing and
 * its absence is a hard error; any other prebuild dirs present get the same
 * treatment defensively.
 */

const SHIPPED_ARCH = 'darwin-arm64';

/**
 * chmod 0755 every `<arch>/spawn-helper` under a node-pty `prebuilds` directory.
 * Throws if the load-bearing SHIPPED_ARCH helper is absent.
 *
 * @param {string} prebuildsDir absolute path to a `node-pty/prebuilds` directory
 * @param {string} remediation context-specific hint appended to the missing-helper error
 * @returns {string[]} absolute paths of the spawn-helper files made executable
 */
function chmodSpawnHelpersUnderPrebuilds(prebuildsDir, remediation) {
  const requiredHelper = join(prebuildsDir, SHIPPED_ARCH, 'spawn-helper');
  if (!existsSync(requiredHelper)) {
    throw new Error(
      `[ensure-node-pty-exec] node-pty ${SHIPPED_ARCH} spawn-helper missing at ${requiredHelper}. ` +
        remediation,
    );
  }

  const chmodded = [];
  for (const archDir of readdirSync(prebuildsDir)) {
    const helper = join(prebuildsDir, archDir, 'spawn-helper');
    if (existsSync(helper) && statSync(helper).isFile()) {
      chmodSync(helper, 0o755);
      chmodded.push(helper);
    }
  }
  return chmodded;
}

/** Resolve the node-pty package directory the runtime actually loads. */
function resolveNodePtyDir() {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve('node-pty/package.json'));
}

/**
 * PACKAGED path (afterPack hook).
 *
 * @param {string} resourcesDir the packed app's `Contents/Resources` directory
 * @returns {string[]} absolute paths of the spawn-helper files made executable
 */
export function ensureNodePtySpawnHelperExecutable(resourcesDir) {
  const prebuildsDir = join(
    resourcesDir,
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
    'prebuilds',
  );
  return chmodSpawnHelpersUnderPrebuilds(
    prebuildsDir,
    `Confirm node-pty is a desktop dependency and the '**/node-pty/prebuilds/**' asarUnpack ` +
      `rule in electron-builder.yml unpacked it — without an executable spawn-helper on the real ` +
      `filesystem, pty.fork() fails at runtime with "posix_spawnp failed".`,
  );
}

/**
 * DEV / CI build+install path (desktop postinstall).
 *
 * `bun install` leaves the prebuilt helper non-executable, and the dev build
 * (`bun run build:desktop` / `dev:electron`, electron-vite, no afterPack) has no
 * step to fix it. Resolves the same node-pty the runtime loads; the `nodePtyDir`
 * parameter is for tests to point at a fixture.
 *
 * @param {string} [nodePtyDir] node-pty package dir; defaults to the resolved install
 * @returns {string[]} absolute paths of the spawn-helper files made executable
 */
export function ensureNodePtySpawnHelperExecutableInNodeModules(nodePtyDir = resolveNodePtyDir()) {
  return chmodSpawnHelpersUnderPrebuilds(
    join(nodePtyDir, 'prebuilds'),
    `Confirm node-pty is installed (it is a desktop dependency) and 'bun install' did not run ` +
      `with --ignore-scripts — without an executable spawn-helper, pty.fork() fails at runtime ` +
      `with "posix_spawnp failed" and the in-app terminal cannot spawn a shell.`,
  );
}

/**
 * @typedef {{ ok: true, chmodded: string[] } | { ok: false, error: Error }} SafeChmodResult
 */

/**
 * Non-throwing wrapper around {@link ensureNodePtySpawnHelperExecutableInNodeModules}
 * for the desktop postinstall. The postinstall must NEVER fail `bun install` over a
 * pathological node-pty layout (a partially-broken install, an absent shipped-arch
 * prebuild) — that would gate the whole monorepo. This converts the throw into a
 * `{ ok: false, error }` result so the caller stays exit-0; the caller owns logging.
 *
 * @param {string} [nodePtyDir] node-pty package dir; defaults to the resolved install
 * @returns {SafeChmodResult}
 */
export function ensureNodePtySpawnHelperExecutableInNodeModulesSafe(nodePtyDir) {
  try {
    return { ok: true, chmodded: ensureNodePtySpawnHelperExecutableInNodeModules(nodePtyDir) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}
