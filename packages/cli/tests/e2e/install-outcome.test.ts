import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import InstallOutcomeReporter from './install-outcome.test-helper';
import { CliInstallUnavailableError } from './packed-install.test-helper';

const execute = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

async function runFixture(
  scenario: 'registry' | 'assets' | 'mixed',
  options: { outsideGit?: boolean; env?: NodeJS.ProcessEnv; event?: unknown } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'ok-cli-outcome-'));
  const config = join(root, 'vitest.config.mts');
  const env = { ...process.env };
  delete env.GITHUB_SHA;
  delete env.GITHUB_EVENT_PATH;
  delete env.GITHUB_BASE_SHA;
  Object.assign(env, options.env);
  if (options.event !== undefined) {
    env.GITHUB_EVENT_PATH = join(root, 'event.json');
    writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(options.event));
  }
  writeFileSync(
    config,
    `import config from ${JSON.stringify(join(here, '../../vitest.e2e.config.ts'))};\nexport default { ...config, test: { ...config.test, include: ['*.test.ts'], maxWorkers: 2 } };\n`,
  );
  for (const failure of scenario === 'mixed' ? ['registry', 'assets'] : [scenario]) {
    writeFileSync(
      join(root, `${failure}.test.ts`),
      `
import { beforeAll, afterAll, expect, test } from ${JSON.stringify(fileURLToPath(import.meta.resolve('vitest')))};
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInstallFixture, LEAF } from ${JSON.stringify(join(here, 'install-fixture.test-helper.ts'))};
import { installPackedCli } from ${JSON.stringify(join(here, 'packed-install.test-helper.ts'))};
const fixture = await createInstallFixture(true);
let installed;
beforeAll(async () => {
  ${failure === 'registry' ? "fixture.responses.set('/' + LEAF + '/-/' + LEAF + '-1.0.0.tgz', 503);" : "writeFileSync(join(fixture.packageDir, 'package.json'), JSON.stringify({ ...fixture.manifest, files: ['dist/cli.mjs'] }));"}
  installed = await installPackedCli(fixture);
});
afterAll(() => fixture.close());
test('packed CLI is ready', () => expect(installed.cliPath).toBeTruthy());
`,
    );
  }
  try {
    try {
      const result = await execute(
        process.execPath,
        [
          join(dirname(require_.resolve('vitest/package.json')), 'vitest.mjs'),
          'run',
          '--root',
          root,
          '--config',
          config,
        ],
        { encoding: 'utf8', env, cwd: options.outsideGit ? root : undefined },
      );
      return { ...result, code: 0 };
    } catch (error) {
      return z.object({ code: z.number(), stdout: z.string(), stderr: z.string() }).parse(error);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the CLI test runner reports acquisition exhaustion as did-not-run', async () => {
  const result = await runFixture('registry');
  expect(result.stdout + result.stderr).toContain('Packed CLI acquisition did-not-run');
  expect(result.code).toBe(77);
  const marker = result.stderr
    .split('\n')
    .find((line) => line.startsWith('INKEEP_GATE_RESULT_V1 '));
  expect(marker).toBeDefined();
  expect(JSON.parse(marker?.slice('INKEEP_GATE_RESULT_V1 '.length) ?? '{}')).toMatchObject({
    class: 'not-run',
    exit: 77,
    outputBytes: expect.any(Number),
  });
  expect(
    JSON.parse(marker?.slice('INKEEP_GATE_RESULT_V1 '.length) ?? '{}').outputBytes,
  ).toBeGreaterThan(0);
});

test('the CLI test runner keeps missing packed assets as a product failure', async () => {
  const result = await runFixture('assets');
  expect(result.stdout + result.stderr).toContain('missing required asset');
  expect(result.code).toBe(1);
  expect(result.stderr).not.toContain('INKEEP_GATE_RESULT_V1');
});

test('a product failure takes precedence over acquisition exhaustion', async () => {
  const result = await runFixture('mixed');
  expect(result.stdout + result.stderr).toContain('Packed CLI acquisition did-not-run');
  expect(result.stdout + result.stderr).toContain('missing required asset');
  expect(result.code).toBe(1);
  expect(result.stderr).not.toContain('INKEEP_GATE_RESULT_V1');
});

test.each([
  { name: 'pull request', event: { pull_request: { base: { sha: 'b'.repeat(40) } } } },
  { name: 'merge group', event: { merge_group: { base_sha: 'b'.repeat(40) } } },
])('reports the available $name comparison identity', async ({ event }) => {
  const result = await runFixture('registry', {
    outsideGit: true,
    env: { GITHUB_SHA: 'a'.repeat(40) },
    event,
  });
  expect(result.code).toBe(77);
  const marker = result.stderr
    .split('\n')
    .find((line) => line.startsWith('INKEEP_GATE_RESULT_V1 '));
  expect(JSON.parse(marker?.slice('INKEEP_GATE_RESULT_V1 '.length) ?? '{}')).toMatchObject({
    head: 'a'.repeat(40),
    base: 'b'.repeat(40),
    class: 'not-run',
  });
});

test('preserves acquisition exhaustion when Git provenance is unavailable', async () => {
  const result = await runFixture('registry', { outsideGit: true, env: { LC_ALL: 'C' } });
  expect(result.code).toBe(77);
  const marker = result.stderr
    .split('\n')
    .find((line) => line.startsWith('INKEEP_GATE_RESULT_V1 '));
  expect(JSON.parse(marker?.slice('INKEEP_GATE_RESULT_V1 '.length) ?? '{}')).toMatchObject({
    head: null,
    base: null,
    class: 'not-run',
  });
  expect(result.stderr).toContain('CLI acquisition result: checkout provenance unavailable');
  expect(result.stderr).toContain('not a git repository');
});

test('preserves acquisition exhaustion when comparison metadata is invalid', async () => {
  const result = await runFixture('registry', {
    outsideGit: true,
    env: { GITHUB_SHA: 'a'.repeat(40) },
    event: { pull_request: { base: { sha: 'invalid' } } },
  });
  expect(result.code).toBe(77);
  const marker = result.stderr
    .split('\n')
    .find((line) => line.startsWith('INKEEP_GATE_RESULT_V1 '));
  expect(JSON.parse(marker?.slice('INKEEP_GATE_RESULT_V1 '.length) ?? '{}')).toMatchObject({
    head: 'a'.repeat(40),
    base: null,
    class: 'not-run',
  });
  expect(result.stderr).toContain('CLI acquisition result: comparison provenance unavailable');
  expect(result.stderr).toContain('"pull_request"');
  expect(result.stderr).toContain('"sha"');
});

test('counts diagnostics once per acquisition when errors propagate', () => {
  const first = { ...new CliInstallUnavailableError('First acquisition', 7), cause: undefined };
  const second = { ...new CliInstallUnavailableError('Second acquisition', 11), cause: undefined };
  let diagnostics = '';
  const originalExit = process.exitCode;
  const output = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    diagnostics += String(chunk);
    return true;
  });
  try {
    new InstallOutcomeReporter().onTestRunEnd([], [first, { ...first }, second], 'failed');
    const marker = diagnostics
      .split('\n')
      .find((line) => line.startsWith('INKEEP_GATE_RESULT_V1 '));
    expect(JSON.parse(marker?.slice('INKEEP_GATE_RESULT_V1 '.length) ?? '{}')).toMatchObject({
      outputBytes: 18,
      class: 'not-run',
    });
    expect(process.exitCode).toBe(77);
  } finally {
    process.exitCode = originalExit;
    output.mockRestore();
  }
});
