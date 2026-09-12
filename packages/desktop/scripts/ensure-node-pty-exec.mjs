#!/usr/bin/env node
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const SHIPPED_ARCH = 'darwin-arm64';

export function shouldEnsureNodePtySpawnHelper(platform = process.platform) {
  return platform === 'darwin';
}

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

function resolveNodePtyDir() {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve('node-pty/package.json'));
}

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

export function ensureNodePtySpawnHelperExecutableInNodeModules(nodePtyDir = resolveNodePtyDir()) {
  return chmodSpawnHelpersUnderPrebuilds(
    join(nodePtyDir, 'prebuilds'),
    `Confirm node-pty is installed (it is a desktop dependency) and 'pnpm install' did not run ` +
      `with --ignore-scripts — without an executable spawn-helper, pty.fork() fails at runtime ` +
      `with "posix_spawnp failed" and the in-app terminal cannot spawn a shell.`,
  );
}

/**
 * @typedef {{ ok: true, chmodded: string[] } | { ok: false, error: Error }} SafeChmodResult
 */

export function ensureNodePtySpawnHelperExecutableInNodeModulesSafe(nodePtyDir) {
  try {
    return { ok: true, chmodded: ensureNodePtySpawnHelperExecutableInNodeModules(nodePtyDir) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}
