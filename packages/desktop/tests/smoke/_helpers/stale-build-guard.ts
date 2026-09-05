import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_PKG = resolve(__dirname, '..', '..', '..');

export interface BuildArtifactCheck {
  name: string;
  out: string;
  srcs: string[];
}

export const BUILD_COMMAND = 'pnpm run build:desktop';

export const CLI_BUILD_COMMAND = 'pnpm --filter @inkeep/open-knowledge run build';

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
  {
    name: 'renderer',
    out: resolve(DESKTOP_PKG, 'out/renderer/index.html'),
    srcs: [],
  },
  {
    name: 'utility server entry',
    out: resolve(DESKTOP_PKG, 'out/main/utility/server-entry.js'),
    srcs: [resolve(DESKTOP_PKG, 'src/utility/server-entry.ts')],
  },
  {
    name: '@inkeep/open-knowledge CLI',
    out: resolve(DESKTOP_PKG, '..', 'cli', 'dist', 'index.mjs'),
    srcs: [],
  },
];

export interface GuardDeps {
  checks?: readonly BuildArtifactCheck[];
  exists?: (path: string) => boolean;
  mtimeMs?: (path: string) => number;
  smokeEnabled?: boolean;
  packagedOverride?: string | undefined;
}

export interface GuardVerdict {
  missing: { name: string; out: string }[];
  stale: string[];
}

export function evaluateBuild(deps: GuardDeps = {}): GuardVerdict {
  const checks = deps.checks ?? CHECKS;
  const exists = deps.exists ?? existsSync;
  const mtime = deps.mtimeMs ?? ((p: string) => statSync(p).mtimeMs);
  const smokeEnabled = deps.smokeEnabled ?? process.env.OK_DESKTOP_E2E_SMOKE === '1';
  const packagedOverride =
    'packagedOverride' in deps ? deps.packagedOverride : process.env.OK_DESKTOP_PACKAGED_APP;
  const packaged = packagedOverride !== undefined && packagedOverride.length > 0;

  const missing: { name: string; out: string }[] = [];
  const stale: string[] = [];

  if (packaged) return { missing, stale };

  for (const check of checks) {
    if (!exists(check.out)) {
      if (smokeEnabled) missing.push({ name: check.name, out: check.out });
      continue;
    }
    const outMtime = mtime(check.out);
    for (const src of check.srcs) {
      if (!exists(src)) continue;
      if (mtime(src) > outMtime) stale.push(`  ${check.name}: ${src} is newer than ${check.out}`);
    }
  }

  return { missing, stale };
}

export function formatMissingArtifacts(missing: readonly { name: string; out: string }[]): string {
  const cli = missing.some((m) => m.name.includes('CLI'));
  return [
    'Required desktop build artifact missing — the smoke harness cannot launch the app.',
    '',
    ...missing.map((m) => `  ${m.name}: ${m.out}`),
    '',
    `Run \`${BUILD_COMMAND}\` from public/open-knowledge before running smoke tests.`,
    ...(cli ? [`The CLI artifact comes from \`${CLI_BUILD_COMMAND}\`.`] : []),
    '',
    'Why this is a hard failure and not a skip: without these, the app never reaches',
    'a window and every smoke test reports an anonymous readiness timeout instead of',
    'naming the artifact that is actually missing.',
  ].join('\n');
}

export function formatStaleArtifacts(stale: readonly string[]): string {
  return [
    'Stale desktop build detected — source files modified after last build.',
    '',
    ...stale,
    '',
    `Run \`${BUILD_COMMAND}\` from public/open-knowledge before re-running smoke tests.`,
    '',
    'Why this matters: the smoke harness launches `out/main/index.js` directly.',
    'If `out/` is older than `src/`, tests run against a phantom version of the app',
    'and produce confusing failures unrelated to your actual changes.',
  ].join('\n');
}

export function runBuildGuard(deps: GuardDeps = {}): void {
  const { missing, stale } = evaluateBuild(deps);
  if (missing.length > 0) throw new Error(formatMissingArtifacts(missing));
  if (stale.length > 0) throw new Error(formatStaleArtifacts(stale));
}

export default function staleBuildGuard(): void {
  runBuildGuard();
}
