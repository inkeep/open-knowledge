import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { configureTestGitRepository } from '../../../test-support/configure-git-fixture.test-helper.ts';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';
import { getMetrics } from './metrics.ts';
import { createManualClock } from './watcher-clock.test-helper.ts';
import { createWatcherDouble } from './watcher-double.test-helper.ts';

let root: string | undefined;
let server: BootedServer | undefined;

afterEach(async () => {
  await server?.destroy();
  server = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function until(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const start = performance.now();
  while (!condition()) {
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('a server whose HEAD watcher gives up reports head-watcher as degraded until it is back', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-head-degraded-')));
  const gitEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root, env: gitEnv });
  configureTestGitRepository(root);
  const clock = createManualClock(Date.now());
  const double = createWatcherDouble();
  const booted = await bootCompositionRig(root, {
    watcherBackend: double.backend,
    watcherClock: clock,
    freshnessIntervalMs: null,
  });
  server = booted;
  await booted.ready;
  const gitDir = join(root, '.git');
  expect(booted.degraded).not.toContain('head-watcher');

  const gaveUpBefore = getMetrics().watcherResubscribesAbandoned;
  for (let failure = 1; failure <= 8; failure++) {
    double.failNextSubscribe(gitDir, new Error(`watch limit ${failure}`));
  }
  double.subscriptionFor(gitDir).fail(new Error('the native watcher died'));
  await until(() => {
    clock.advance(30_000);
    return getMetrics().watcherResubscribesAbandoned > gaveUpBefore;
  }, 'the HEAD watcher to give up');
  expect(booted.degraded).toContain('head-watcher');

  clock.advance(5 * 60_000);
  await until(() => !booted.degraded.includes('head-watcher'), 'the HEAD watcher to be back');
  expect(double.subscriptionCount(gitDir)).toBe(2);
});
