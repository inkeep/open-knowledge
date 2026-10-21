import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';
import { getMetrics } from './metrics.ts';
import { createManualClock } from './watcher-clock.test-helper.ts';
import { createWatcherDouble } from './watcher-double.test-helper.ts';
import { FRESHNESS_BASE_INTERVAL_MS } from './watcher-freshness.ts';

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

test('a booted server re-checks the content tree every five seconds unless told otherwise', async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-freshness-default-')));
  const clock = createManualClock(Date.now());
  server = await bootCompositionRig(root, {
    watcherBackend: createWatcherDouble().backend,
    watcherClock: clock,
  });
  await server.ready;
  writeFileSync(join(root, 'never-delivered.md'), '# Never delivered\n');
  const passesBefore = getMetrics().freshnessPasses;
  const findsBefore = getMetrics().freshnessFinds;

  clock.advance(FRESHNESS_BASE_INTERVAL_MS);
  await until(() => getMetrics().freshnessPasses > passesBefore, 'the first timed pass');
  expect(getMetrics().freshnessFinds - findsBefore).toBeGreaterThanOrEqual(1);
});
