#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  ensureNodePtySpawnHelperExecutableInNodeModulesSafe,
  shouldEnsureNodePtySpawnHelper,
} from './ensure-node-pty-exec.mjs';

if (shouldEnsureNodePtySpawnHelper()) {
  const spawnHelper = ensureNodePtySpawnHelperExecutableInNodeModulesSafe();
  if (spawnHelper.ok) {
    console.log(
      `[desktop postinstall] node-pty spawn-helper marked executable (${spawnHelper.chmodded.length} file(s))`,
    );
  } else {
    console.warn(
      `[desktop postinstall] could not make node-pty spawn-helper executable: ${spawnHelper.error.message}`,
    );
  }
}

if (process.env.ELECTRON_SKIP_REBUILD === '1') {
  console.log(
    '[desktop postinstall] ELECTRON_SKIP_REBUILD=1 — skipping electron-builder install-app-deps',
  );
  process.exit(0);
}

if (process.env.CI && process.env.ELECTRON_SKIP_REBUILD !== '0') {
  console.log(
    '[desktop postinstall] CI detected — skipping electron-builder install-app-deps ' +
      '(set ELECTRON_SKIP_REBUILD=0 to force).',
  );
  process.exit(0);
}

const child = spawn('electron-builder', ['install-app-deps'], {
  stdio: 'inherit',
  shell: true,
});

child.on('exit', (code) => {
  if (code !== 0) {
    console.warn(
      `[desktop postinstall] electron-builder install-app-deps exited with code ${code} — ` +
        'continuing anyway. Native modules for the desktop app may need manual rebuild. ' +
        'Set ELECTRON_SKIP_REBUILD=1 to silence this step.',
    );
  }
  process.exit(0);
});

child.on('error', (err) => {
  console.warn(
    `[desktop postinstall] electron-builder install-app-deps failed to spawn: ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
  console.warn('[desktop postinstall] Skipping — run `pnpm run rebuild:native` manually if needed');
  process.exit(0);
});
