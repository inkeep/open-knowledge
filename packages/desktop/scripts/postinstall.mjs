#!/usr/bin/env node
/**
 * Desktop postinstall — two install-producer fix-ups: (1) make node-pty's prebuilt
 * `spawn-helper` executable for the dev/CI build (the afterPack analog; runs first,
 * unconditionally), then (2) rebuild native modules (`@parcel/watcher`, etc.) against
 * the pinned Electron Node ABI so packaged + dev loads can `dlopen` the binaries.
 *
 * Agent-first default runs `electron-builder install-app-deps` on every
 * `bun install`. Non-desktop contributors opt out via `ELECTRON_SKIP_REBUILD=1` in
 * their shell profile — saves ~150MB of Electron headers on first install and a
 * few seconds on subsequent ones.
 *
 * Keeping this as a Node script (not a raw shell one-liner) so the skip-check
 * runs cross-platform (macOS / Linux / Windows) without shell-syntax surprises.
 */
import { spawn } from 'node:child_process';
import { ensureNodePtySpawnHelperExecutableInNodeModulesSafe } from './ensure-node-pty-exec.mjs';

// node-pty ships its prebuilt `spawn-helper` non-executable (node-pty#850) and
// `bun install` preserves that mode, so the dev/CI build (`bun run build:desktop`
// / `dev:electron`, electron-vite, no afterPack) launches with a terminal that
// dies "posix_spawnp failed". The packaged `.app` fixes this in afterPack; this is
// the dev/CI analog at the install producer that strips the bit. It runs FIRST and
// UNCONDITIONALLY — before the ELECTRON_SKIP_REBUILD / CI early-exits below —
// because CI desktop-smoke is one of the affected environments and the +x bit is
// independent of the electron-builder native rebuild those guards gate. The Safe
// wrapper never throws so a pathological node-pty layout can't gate the whole
// monorepo's `bun install` (matching this script's install-app-deps stance below).
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

if (process.env.ELECTRON_SKIP_REBUILD === '1') {
  console.log(
    '[desktop postinstall] ELECTRON_SKIP_REBUILD=1 — skipping electron-builder install-app-deps',
  );
  process.exit(0);
}

// GitHub Actions + most CI providers set `CI=true`. We also skip on CI
// because Linux runners that don't exercise the desktop app can't
// `install-app-deps` (electron's platform binary isn't guaranteed present,
// and when it's missing electron-builder errors with "Cannot compute
// electron version from installed node modules" — that cascades into every
// downstream typecheck/test/lint job failing at `bun install`). Desktop
// contributors running CI manually can set ELECTRON_SKIP_REBUILD=0 to
// opt back in — the opt-out is for machines that don't need it.
if (process.env.CI && process.env.ELECTRON_SKIP_REBUILD !== '0') {
  console.log(
    '[desktop postinstall] CI detected — skipping electron-builder install-app-deps ' +
      '(set ELECTRON_SKIP_REBUILD=0 to force).',
  );
  process.exit(0);
}

// Local desktop dev — run install-app-deps but soften failures to a warning.
// A broken install shouldn't gate the whole monorepo's `bun install`.
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
  console.warn('[desktop postinstall] Skipping — run `bun run rebuild:native` manually if needed');
  process.exit(0);
});
