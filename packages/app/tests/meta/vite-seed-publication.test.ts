import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { spawnUnderOwnerLifeline } from '../../../../test-support/owner-lifeline.ts';
import { APP_PACKAGE_ROOT } from '../stress/_helpers/seed-key.ts';
import { removeRaceArtifacts } from '../stress/_helpers/vite-seed-race/race-artifacts.ts';

const REPRODUCTION = fileURLToPath(
  new URL('../stress/_helpers/vite-seed-race/reproduce.mjs', import.meta.url),
);

test('warm seed publication keeps a concurrent worker copyable', {
  timeout: 180_000,
}, async ({ signal, onTestFinished, onTestFailed }) => {
  const runDir = mkdtempSync(join(tmpdir(), 'ok-vite-warm-race-'));
  const consumerCacheToken = randomUUID();
  const { child, commandResult } = spawnUnderOwnerLifeline('pnpm', ['exec', 'tsx', REPRODUCTION], {
    cwd: APP_PACKAGE_ROOT,
    env: {
      ...process.env,
      VITE_RACE_RUN_DIR: runDir,
      VITE_RACE_CONSUMER_CACHE_TOKEN: consumerCacheToken,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    closed.then(resolve);
  });
  let treeEnded: Promise<void> | undefined;
  const endTree = () => {
    if (treeEnded === undefined) {
      child.stdin.end();
      treeEnded = closed;
    }
    return treeEnded;
  };
  signal.addEventListener('abort', endTree, { once: true });
  onTestFinished(async () => {
    await endTree();
    const failures = removeRaceArtifacts({ runDir, consumerCacheToken });
    if (failures.length > 0) {
      throw new Error(
        `The warm seed race reproduction left artifacts it could not remove:\n${failures.join('\n')}`,
      );
    }
  });
  onTestFailed(() => {
    throw new Error(
      `The warm seed race reproduction's streams.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  });

  const [result] = await Promise.all([commandResult, exited]);
  expect(result, 'reproduce.mjs must exit on its own with code 0').toEqual({
    code: 0,
    signal: null,
  });
  expect(JSON.parse(stdout)).toMatchObject({
    consumerResult: { status: 'passed', copiedMetadata: true },
    producerResult: { status: 'passed' },
    producerPublished: true,
    consumerCopyDone: true,
  });
});
