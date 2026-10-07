import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import {
  BROWSER_TIER_COMMAND,
  CHROMIUM_GC_FORCE_ENV,
  CHROMIUM_GC_THRESHOLD_ENV,
  readChromiumGcLaunchEnv,
} from '../foundation/chromium-gc-launch-env';

const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VITEST_CLI = resolve(
  dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))),
  'vitest.mjs',
);
const RUN_TIMEOUT_MS = 20_000;
const GB = 1024 ** 3;
const FREE_TEMP_BYTES = 80 * GB;
const LAUNCH_SETTINGS = { [CHROMIUM_GC_THRESHOLD_ENV]: '100000', [CHROMIUM_GC_FORCE_ENV]: '1' };

type CliRun = { exitCode: number | string | null; killed: boolean; output: string };

const scratch: string[] = [];

function scratchConfig(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-browser-tier-'));
  scratch.push(dir);
  const config = join(dir, 'vitest.browser.config.mts');
  writeFileSync(config, source);
  return config;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runBrowserTier(
  args: string[],
  gcEnv: Record<string, string>,
  config = 'vitest.browser.config.ts',
): Promise<CliRun> {
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...gcEnv };
  if (!(CHROMIUM_GC_THRESHOLD_ENV in gcEnv)) delete env[CHROMIUM_GC_THRESHOLD_ENV];
  if (!(CHROMIUM_GC_FORCE_ENV in gcEnv)) delete env[CHROMIUM_GC_FORCE_ENV];
  return new Promise((resolveRun) => {
    execFile(
      process.execPath,
      [VITEST_CLI, 'run', '--config', config, ...args],
      { cwd: APP_ROOT, env, timeout: RUN_TIMEOUT_MS },
      (error, stdout, stderr) => {
        resolveRun({
          exitCode: error?.code ?? 0,
          killed: error?.killed ?? false,
          output: `${stdout}\n${stderr}`,
        });
      },
    );
  });
}

describe('the browser tier launch environment', () => {
  test('the documented threshold and force settings are accepted', () => {
    expect(
      readChromiumGcLaunchEnv(
        { [CHROMIUM_GC_THRESHOLD_ENV]: '100000', [CHROMIUM_GC_FORCE_ENV]: '1' },
        FREE_TEMP_BYTES,
      ),
    ).toEqual({ ok: true, thresholdBytes: 100000 * GB });
  });

  test('an environment missing both settings names each one', () => {
    expect(readChromiumGcLaunchEnv({}, FREE_TEMP_BYTES)).toEqual({
      ok: false,
      problems: [
        'VITEST_CHROMIUM_GC_DISK_THRESHOLD_GB is not set',
        'VITEST_CHROMIUM_GC_FORCE is not set',
      ],
    });
  });

  test.each(['', ' ', 'abc', '0', '-5', 'Infinity'])(
    'a threshold of %j is refused as not a positive number of GB',
    (threshold) => {
      expect(
        readChromiumGcLaunchEnv(
          { [CHROMIUM_GC_THRESHOLD_ENV]: threshold, [CHROMIUM_GC_FORCE_ENV]: '1' },
          FREE_TEMP_BYTES,
        ),
      ).toEqual({
        ok: false,
        problems: [
          `VITEST_CHROMIUM_GC_DISK_THRESHOLD_GB=${threshold} is not a positive number of GB`,
        ],
      });
    },
  );

  test('a threshold at the free temp space is refused, because Vitest would then skip the collection, and one just above it is accepted', () => {
    const atFreeSpace = readChromiumGcLaunchEnv(
      { [CHROMIUM_GC_THRESHOLD_ENV]: '80', [CHROMIUM_GC_FORCE_ENV]: '1' },
      FREE_TEMP_BYTES,
    );
    expect(atFreeSpace.ok).toBe(false);
    expect(atFreeSpace.ok ? [] : atFreeSpace.problems).toEqual([
      'VITEST_CHROMIUM_GC_DISK_THRESHOLD_GB=80 does not exceed the 80.0 GB free in the temp directory, so Vitest would skip the collection after each file',
    ]);
    expect(
      readChromiumGcLaunchEnv(
        { [CHROMIUM_GC_THRESHOLD_ENV]: '80.5', [CHROMIUM_GC_FORCE_ENV]: '1' },
        FREE_TEMP_BYTES,
      ).ok,
    ).toBe(true);
  });

  test.each(['', '0', 'true'])('a force setting of %j is refused as not 1', (force) => {
    expect(
      readChromiumGcLaunchEnv(
        { [CHROMIUM_GC_THRESHOLD_ENV]: '100000', [CHROMIUM_GC_FORCE_ENV]: force },
        FREE_TEMP_BYTES,
      ),
    ).toEqual({ ok: false, problems: [`VITEST_CHROMIUM_GC_FORCE=${force} is not 1`] });
  });

  test('the browser tier invocation refuses to start without the launch settings and names the documented command', async () => {
    const run = await runBrowserTier(
      ['tests/foundation/compiled-destination.browser.test.tsx'],
      {},
    );

    expect(run.killed).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.output).toContain('The browser tier refuses to start');
    expect(run.output).toContain(`Run it as: ${BROWSER_TIER_COMMAND}`);
    expect(run.output).not.toContain('Test Files');
  });

  test('a browser tier invocation that selects no test file fails instead of passing', async () => {
    const run = await runBrowserTier(['tests/foundation/no-such-browser-test'], LAUNCH_SETTINGS);

    expect(run.killed).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.output).toContain('No test files found');
    expect(run.output).not.toContain('passed');
  });

  test('a malformed browser tier config fails the invocation instead of passing', async () => {
    const config = scratchConfig(
      "export default { test: { browser: { enabled: true, instances: [{ browser: 'chromium' }] }\n",
    );

    const run = await runBrowserTier([], LAUNCH_SETTINGS, config);

    expect(run.killed).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.output).toContain(`failed to load config from ${config}`);
    expect(run.output).not.toContain('Test Files');
  });

  test('a browser tier config that names no browser instance fails instead of running nothing', async () => {
    const config = scratchConfig(
      [
        `import { appBrowserVitestConfig } from ${JSON.stringify(join(APP_ROOT, 'vitest.browser.config.ts'))};`,
        'const { test } = appBrowserVitestConfig;',
        'export default { ...appBrowserVitestConfig, test: { ...test, browser: { ...test.browser, instances: [] } } };',
        '',
      ].join('\n'),
    );

    const run = await runBrowserTier(
      ['tests/foundation/compiled-destination.browser.test.tsx'],
      LAUNCH_SETTINGS,
      config,
    );

    expect(run.killed).toBe(false);
    expect(run.exitCode).toBe(1);
    expect(run.output).toContain("Vitest wasn't able to resolve any project");
    expect(run.output).not.toContain('Test Files');
  });
});
