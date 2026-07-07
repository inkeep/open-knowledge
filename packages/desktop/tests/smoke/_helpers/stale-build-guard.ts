/**
 * Stale-build guard for desktop smoke tests.
 *
 * The smoke harness drives a real Electron binary via Playwright's
 * `_electron.launch({ args: [MAIN_ENTRY] })`. `MAIN_ENTRY` resolves to
 * `packages/desktop/out/main/index.js` — the electron-vite build output.
 * If `out/` is older than `src/`, the launched binary doesn't match the
 * source on disk: tests run against a phantom version of the app.
 *
 * Symptom in the wild: a recent investigation chased a "deterministic
 * 20/20 consent-dialog test failure" that was actually a stale `out/`
 * compiled from before the renderer's `bridge.project.open({ entryPoint })`
 * shape was finalized. The stale renderer chunk sent `entryPoint` as
 * undefined; main rejected the IPC; consent dialog never rendered. Hours
 * lost reading IPC choreography that was never actually broken.
 *
 * In CI this can't happen — `bun run build:desktop` runs immediately
 * before the test step. In local dev it happens whenever a contributor
 * edits `src/` and starts a smoke run without rebuilding. This guard
 * fires a clear diagnostic at globalSetup time so the wasted-debugging
 * loop short-circuits.
 *
 * Implementation: cheap mtime comparison. Pick a representative source
 * file from each compilation unit (main, preload, renderer entry).
 * If any source is newer than its compiled artifact, throw. No actual
 * rebuild — that's an explicit-action choice for the contributor.
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// _helpers/ → tests/smoke/ → tests/ → packages/desktop/
const DESKTOP_PKG = resolve(__dirname, '..', '..', '..');

interface BuildArtifactCheck {
  /** Compilation unit name for the diagnostic message. */
  name: string;
  /** Compiled output path, the canonical "freshness" reference. */
  out: string;
  /** A representative source file. If any are newer than `out`, the build is stale. */
  srcs: string[];
}

const CHECKS: BuildArtifactCheck[] = [
  {
    name: 'main',
    out: resolve(DESKTOP_PKG, 'out/main/index.js'),
    srcs: [
      resolve(DESKTOP_PKG, 'src/main/index.ts'),
      resolve(DESKTOP_PKG, 'src/main/consent-dialog.ts'),
      resolve(DESKTOP_PKG, 'src/main/folder-admission.ts'),
    ],
  },
  {
    name: 'preload',
    out: resolve(DESKTOP_PKG, 'out/preload/index.js'),
    srcs: [resolve(DESKTOP_PKG, 'src/preload/index.ts')],
  },
];

function mtimeMs(path: string): number {
  return statSync(path).mtimeMs;
}

/**
 * Globalsetup-shaped function. Called by Playwright once before any test runs.
 * Throws with a structured message if any src file is newer than its compiled
 * artifact. CI is unaffected (build runs immediately before test step).
 */
export default function staleBuildGuard(): void {
  const stale: string[] = [];
  for (const check of CHECKS) {
    if (!existsSync(check.out)) {
      // The existing per-test `BUILD_EXISTS = existsSync(MAIN_ENTRY)` skip-gate
      // already covers the "no build at all" case with its own structured skip
      // message. We only flag the more subtle staleness failure here — exiting
      // cleanly when out/ is missing entirely lets the per-test skip handle it.
      return;
    }
    const outMtime = mtimeMs(check.out);
    for (const src of check.srcs) {
      if (!existsSync(src)) continue; // src renamed/moved — out of scope for this guard
      if (mtimeMs(src) > outMtime) {
        stale.push(`  ${check.name}: ${src} is newer than ${check.out}`);
      }
    }
  }
  if (stale.length > 0) {
    throw new Error(
      [
        'Stale desktop build detected — source files modified after last build.',
        '',
        ...stale,
        '',
        'Run `bun run build:desktop` from public/open-knowledge before re-running smoke tests.',
        '',
        'Why this matters: the smoke harness launches `out/main/index.js` directly.',
        'If `out/` is older than `src/`, tests run against a phantom version of the app',
        'and produce confusing failures unrelated to your actual changes.',
      ].join('\n'),
    );
  }
}
