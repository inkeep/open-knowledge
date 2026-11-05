import { spawn } from 'node:child_process';
import { existsSync, mkdtempDisposableSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type TestContext, test } from 'vitest';

const server = fileURLToPath(new URL('../..', import.meta.url));
const vitest = join(
  dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))),
  'vitest.mjs',
);
const setup = fileURLToPath(new URL('./launch-release-age-replay.test-helper.ts', import.meta.url));
const config = fileURLToPath(new URL('../../vitest.network.config.ts', import.meta.url));

async function replayCatalog(acquisitionFails: boolean, ctx: TestContext) {
  using dir = mkdtempDisposableSync(join(tmpdir(), 'acp-catalog-replay-'));
  const report = join(dir.path, 'results.json');
  const configFile = join(dir.path, 'vitest.config.mjs');
  writeFileSync(
    configFile,
    `
    import config from ${JSON.stringify(config)};
    export default { ...config, test: { ...config.test,
      include: ['src/acp/launch-release-age.network.test.ts'],
      setupFiles: [...config.test.setupFiles, ${JSON.stringify(setup)}],
      testNamePattern: 'the acquisition catalog|fixture-live-adapter',
      pool: 'threads', reporters: ['json'], outputFile: ${JSON.stringify(report)}
    } };
  `,
  );
  const lifeline =
    'data:text/javascript,' +
    encodeURIComponent("process.on('disconnect', () => process.exit(1)); process.channel.unref();");
  const child = spawn(
    process.execPath,
    ['--import', lifeline, vitest, 'run', '--config', configFile],
    {
      cwd: server,
      env: {
        PATH: process.env.PATH,
        HOME: dir.path,
        TMPDIR: dir.path,
        SystemRoot: process.env.SystemRoot,
        ACP_REPLAY_FAILURE: acquisitionFails ? '1' : '0',
        CI: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      signal: ctx.signal,
      timeout: 60_000,
    },
  );
  let stdout = '';
  let stderr = '';
  let error: Error | undefined;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.once('error', (cause) => {
    error = cause;
  });
  const closed = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('close', (status, signal) => resolve({ status, signal }));
    },
  );
  ctx.onTestFinished(async () => {
    if (child.connected) child.disconnect();
    await closed;
  });
  const result = await closed;
  expect(error, stderr).toBeUndefined();
  expect(result.signal, stderr).toBeNull();
  expect(existsSync(report), stdout + stderr).toBe(true);
  const output = JSON.parse(readFileSync(report, 'utf8'));
  return {
    status: result.status,
    assertions: output.testResults.flatMap(
      (suite: { assertionResults: { fullName: string; status: string }[] }) =>
        suite.assertionResults,
    ),
  };
}

test('a changed live catalog still checks its new site without failing for descriptor drift', async (ctx) => {
  const result = await replayCatalog(false, ctx);
  expect(result.status, JSON.stringify(result.assertions)).toBe(0);
  expect(result.assertions).toContainEqual(
    expect.objectContaining({
      fullName: expect.stringContaining('fixture-live-adapter produces an admissible npm plan'),
      status: 'passed',
    }),
  );
}, 75_000);

test('an acquisition failure at a newly listed live site still fails the lane by assertion', async (ctx) => {
  const result = await replayCatalog(true, ctx);
  expect(result.status).toBe(1);
  expect(result.assertions).toContainEqual(
    expect.objectContaining({
      fullName: expect.stringContaining('fixture-live-adapter produces an admissible npm plan'),
      status: 'failed',
    }),
  );
}, 75_000);
