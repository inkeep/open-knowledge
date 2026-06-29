
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_PKG = resolve(__dirname, '..', '..', '..');

interface BuildArtifactCheck {
  name: string;
  out: string;
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

export default function staleBuildGuard(): void {
  const stale: string[] = [];
  for (const check of CHECKS) {
    if (!existsSync(check.out)) {
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
