#!/usr/bin/env node
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SHIPPED_ARCH = 'darwin-arm64';

const prebuildsDirFor = (resourcesDir) =>
  join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds');

export function ensureNodePtySpawnHelperExecutable(resourcesDir) {
  const prebuildsDir = prebuildsDirFor(resourcesDir);
  const requiredHelper = join(prebuildsDir, SHIPPED_ARCH, 'spawn-helper');
  if (!existsSync(requiredHelper)) {
    throw new Error(
      `[ensure-node-pty-exec] node-pty ${SHIPPED_ARCH} spawn-helper missing at ${requiredHelper}. ` +
        `Confirm node-pty is a desktop dependency and the '**/node-pty/prebuilds/**' asarUnpack ` +
        `rule in electron-builder.yml unpacked it — without an executable spawn-helper on the real ` +
        `filesystem, pty.fork() fails at runtime with "posix_spawnp failed".`,
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
