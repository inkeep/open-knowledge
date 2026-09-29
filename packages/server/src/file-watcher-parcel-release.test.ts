import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type DiskEvent, startWatcher, type WatcherHandle } from './file-watcher.ts';
import {
  forgetNativeSubscriptions,
  type NativeSubscriptionDouble,
  nativeSubscriptionOn,
} from './parcel-watcher-double.test-helper.ts';

vi.mock('@parcel/watcher', async () => {
  const { parcelWatcherModule } = await import('./parcel-watcher-double.test-helper.ts');
  return parcelWatcherModule;
});

const POSIX_PLATFORMS = ['linux', 'darwin'] as const satisfies readonly NodeJS.Platform[];
const PLATFORMS = ['win32', ...POSIX_PLATFORMS] as const satisfies readonly NodeJS.Platform[];
const LIVENESS = { timeout: 10_000 };

let contentDir: string;

beforeEach(() => {
  forgetNativeSubscriptions();
  contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-parcel-release-')));
});

afterEach(() => {
  rmSync(contentDir, { recursive: true, force: true });
});

interface WatchedContent {
  readonly watcher: WatcherHandle;
  readonly subscription: NativeSubscriptionDouble;
  readonly dispatched: string[];
  readonly rawBatches: (readonly string[])[];
}

function dispatchLabel(event: DiskEvent): string {
  return event.kind === 'create' ? `create ${event.docName}` : event.kind;
}

async function watchContent(platform: NodeJS.Platform): Promise<WatchedContent> {
  const dispatched: string[] = [];
  const rawBatches: (readonly string[])[] = [];
  const watcher = await startWatcher(
    contentDir,
    async (event) => {
      dispatched.push(dispatchLabel(event));
    },
    undefined,
    {
      forceBackend: 'parcel',
      platform,
      onRawBatch: (paths) => {
        rawBatches.push(paths);
      },
    },
  );
  return { watcher, subscription: nativeSubscriptionOn(contentDir), dispatched, rawBatches };
}

function writeDoc(name: string): string {
  const path = join(contentDir, name);
  writeFileSync(path, `# ${name}\n`, 'utf-8');
  return path;
}

async function deliverLiveCreate(watched: WatchedContent): Promise<string> {
  const before = writeDoc('before.md');
  await watched.subscription.deliver([{ type: 'create', path: before }]);
  await vi.waitFor(() => expect(watched.dispatched).toEqual(['create before']), LIVENESS);
  return before;
}

describe('releasing the file watcher on the parcel backend', () => {
  test('on win32, releasing the file watcher never asks the addon to unsubscribe natively', async () => {
    const { watcher, subscription } = await watchContent('win32');

    await watcher.unsubscribe();

    expect(subscription.nativeReleases(), 'native unsubscribe calls').toBe(0);
  });

  test.each(PLATFORMS)(
    'on %s, a create the addon delivers after the file watcher is released reaches no consumer',
    async (platform) => {
      const watched = await watchContent(platform);
      const before = await deliverLiveCreate(watched);

      await watched.watcher.unsubscribe();
      await watched.subscription.deliver([{ type: 'create', path: writeDoc('after.md') }]);

      expect({ rawBatches: watched.rawBatches, dispatched: watched.dispatched }).toEqual({
        rawBatches: [[before]],
        dispatched: ['create before'],
      });
    },
  );

  test.each(POSIX_PLATFORMS)(
    'on %s, a create the addon delivers while the native unsubscribe is in flight reaches no consumer',
    async (platform) => {
      const watched = await watchContent(platform);
      const before = await deliverLiveCreate(watched);

      watched.subscription.deliverWhileReleasing([{ type: 'create', path: writeDoc('during.md') }]);
      await watched.watcher.unsubscribe();

      expect(watched.subscription.nativeReleases(), 'native unsubscribe calls').toBe(1);
      expect({ rawBatches: watched.rawBatches, dispatched: watched.dispatched }).toEqual({
        rawBatches: [[before]],
        dispatched: ['create before'],
      });
    },
  );

  test.each(POSIX_PLATFORMS)(
    'characterization: on %s, releasing the file watcher unsubscribes the addon exactly once',
    async (platform) => {
      const { watcher, subscription } = await watchContent(platform);

      await watcher.unsubscribe();

      expect(subscription.nativeReleases(), 'native unsubscribe calls').toBe(1);
    },
  );
});
