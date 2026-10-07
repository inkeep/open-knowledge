import { statfsSync } from 'node:fs';
import type { Plugin } from 'vite';

export const CHROMIUM_GC_THRESHOLD_ENV = 'VITEST_CHROMIUM_GC_DISK_THRESHOLD_GB';
export const CHROMIUM_GC_FORCE_ENV = 'VITEST_CHROMIUM_GC_FORCE';

export const BROWSER_TIER_COMMAND =
  'env VITEST_CHROMIUM_GC_DISK_THRESHOLD_GB=100000 VITEST_CHROMIUM_GC_FORCE=1 pnpm --dir packages/app run test:browser';

const BYTES_PER_GB = 1024 ** 3;

export type ChromiumGcLaunchEnv =
  | { readonly ok: true; readonly thresholdBytes: number }
  | { readonly ok: false; readonly problems: readonly string[] };

export function readChromiumGcLaunchEnv(
  env: Readonly<Record<string, string | undefined>>,
  availableTempBytes: number,
): ChromiumGcLaunchEnv {
  const problems: string[] = [];
  const rawThreshold = env[CHROMIUM_GC_THRESHOLD_ENV];
  const thresholdGb = rawThreshold === undefined ? Number.NaN : Number(rawThreshold);
  const thresholdBytes = thresholdGb * BYTES_PER_GB;
  if (rawThreshold === undefined) {
    problems.push(`${CHROMIUM_GC_THRESHOLD_ENV} is not set`);
  } else if (!Number.isFinite(thresholdGb) || thresholdGb <= 0) {
    problems.push(`${CHROMIUM_GC_THRESHOLD_ENV}=${rawThreshold} is not a positive number of GB`);
  } else if (thresholdBytes <= availableTempBytes) {
    problems.push(
      `${CHROMIUM_GC_THRESHOLD_ENV}=${rawThreshold} does not exceed the ${(availableTempBytes / BYTES_PER_GB).toFixed(1)} GB free in the temp directory, so Vitest would skip the collection after each file`,
    );
  }
  const force = env[CHROMIUM_GC_FORCE_ENV];
  if (force === undefined) {
    problems.push(`${CHROMIUM_GC_FORCE_ENV} is not set`);
  } else if (force !== '1') {
    problems.push(`${CHROMIUM_GC_FORCE_ENV}=${force} is not 1`);
  }
  return problems.length === 0 ? { ok: true, thresholdBytes } : { ok: false, problems };
}

export function describeChromiumGcLaunchRefusal(problems: readonly string[]): string {
  return [
    'The browser tier refuses to start: Vitest reads its Chromium memory controls when it is imported, so they must be in the launch environment.',
    ...problems.map((problem) => `  - ${problem}`),
    `Run it as: ${BROWSER_TIER_COMMAND}`,
  ].join('\n');
}

function availableTempBytes(): number {
  const stats = statfsSync(process.env.TMPDIR || '/tmp');
  return stats.bavail * stats.bsize;
}

export function chromiumGcLaunchEnvGuard(): Plugin {
  return {
    name: 'ok:chromium-gc-launch-env',
    config() {
      const launch = readChromiumGcLaunchEnv(process.env, availableTempBytes());
      if (!launch.ok) throw new Error(describeChromiumGcLaunchRefusal(launch.problems));
    },
  };
}
