import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { configureTestGitRepository } from '../../../test-support/configure-git-fixture.test-helper.ts';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';
import { getWatcherDecisionRingSnapshot } from './file-watcher.ts';
import { getMetrics } from './metrics.ts';
import {
  forgetNativeSubscriptions,
  nativeSubscriptionDirs,
  nativeSubscriptionOn,
} from './parcel-watcher-double.test-helper.ts';

vi.mock('@parcel/watcher', async () => {
  const { parcelWatcherModule } = await import('./parcel-watcher-double.test-helper.ts');
  return parcelWatcherModule;
});

const LIVENESS = { timeout: 10_000 };

let root: string;
let server: BootedServer | undefined;

beforeEach(() => {
  forgetNativeSubscriptions();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-parcel-shutdown-')));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  configureTestGitRepository(root);
});

afterEach(async () => {
  try {
    await server?.destroy();
  } finally {
    server = undefined;
    rmSync(root, { recursive: true, force: true });
  }
});

function writeDoc(name: string): string {
  const path = join(root, name);
  writeFileSync(path, `# ${name}\n`, 'utf-8');
  return path;
}

function dispatchedKinds(fileName: string): string[] {
  return getWatcherDecisionRingSnapshot()
    .filter(
      (record) => record.decision === 'dispatched' && record.path.endsWith(`${sep}${fileName}`),
    )
    .map((record) => record.kind);
}

test('once the server is destroyed, a native delivery neither dispatches a disk event nor begins a batch', async () => {
  server = await bootCompositionRig(root);
  await server.ready;
  const gitDir = join(root, '.git');
  expect(nativeSubscriptionDirs().sort()).toEqual([root, gitDir].sort());
  const content = nativeSubscriptionOn(root);
  const head = nativeSubscriptionOn(gitDir);
  const headUpdate: { type: 'update'; path: string } = {
    type: 'update',
    path: join(gitDir, 'HEAD'),
  };

  await content.deliver([{ type: 'create', path: writeDoc('before.md') }]);
  await vi.waitFor(() => expect(dispatchedKinds('before.md')).toEqual(['create']), LIVENESS);
  const batchesBeforeHeadUpdate = getMetrics().batchCount;
  await head.deliver([headUpdate]);
  await vi.waitFor(
    () => expect(getMetrics().batchCount).toBe(batchesBeforeHeadUpdate + 1),
    LIVENESS,
  );

  await server.destroy();
  server = undefined;

  const nativeReleasesPerSubscription = process.platform === 'win32' ? 0 : 1;
  expect({ content: content.nativeReleases(), head: head.nativeReleases() }).toEqual({
    content: nativeReleasesPerSubscription,
    head: nativeReleasesPerSubscription,
  });

  const batchesAtDestroy = getMetrics().batchCount;
  await content.deliver([{ type: 'create', path: writeDoc('after.md') }]);
  await head.deliver([headUpdate]);

  expect({
    dispatched: dispatchedKinds('after.md'),
    batchesBegun: getMetrics().batchCount - batchesAtDestroy,
  }).toEqual({ dispatched: [], batchesBegun: 0 });
}, 60_000);
