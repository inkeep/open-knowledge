import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type HeadWatcherHandle, startHeadWatcher } from './head-watcher.ts';
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

type HeadWatcherOptions = NonNullable<Parameters<typeof startHeadWatcher>[3]>;
type ParcelHeadWatcherOptions = HeadWatcherOptions & { readonly platform: NodeJS.Platform };

function parcelBackendOn(platform: NodeJS.Platform): ParcelHeadWatcherOptions {
  return { forceBackend: 'parcel', platform };
}

let projectRoot: string;
let gitDir: string;

beforeEach(() => {
  forgetNativeSubscriptions();
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ok-parcel-head-release-')));
  gitDir = join(projectRoot, '.git');
  mkdirSync(gitDir);
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n', 'utf-8');
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

interface WatchedHead {
  readonly handle: HeadWatcherHandle;
  readonly subscription: NativeSubscriptionDouble;
  readonly batchTriggers: string[];
}

async function watchHead(platform: NodeJS.Platform): Promise<WatchedHead> {
  const batchTriggers: string[] = [];
  const handle = await startHeadWatcher(
    projectRoot,
    ({ trigger }) => {
      batchTriggers.push(trigger);
    },
    () => {},
    parcelBackendOn(platform),
  );
  return { handle, subscription: nativeSubscriptionOn(gitDir), batchTriggers };
}

function headUpdateEvent(): { type: 'update'; path: string } {
  return { type: 'update', path: join(gitDir, 'HEAD') };
}

async function beginLiveBatch(watched: WatchedHead): Promise<void> {
  await watched.subscription.deliver([headUpdateEvent()]);
  await vi.waitFor(() => expect(watched.batchTriggers).toEqual(['HEAD']), LIVENESS);
}

describe('releasing the HEAD watcher on the parcel backend', () => {
  test('on win32, releasing the HEAD watcher never asks the addon to unsubscribe natively', async () => {
    const { handle, subscription } = await watchHead('win32');

    await handle.unsubscribe();

    expect(subscription.nativeReleases(), 'native unsubscribe calls').toBe(0);
  });

  test.each(PLATFORMS)(
    'on %s, a HEAD change the addon delivers after the HEAD watcher is released begins no batch',
    async (platform) => {
      const watched = await watchHead(platform);
      await beginLiveBatch(watched);

      await watched.handle.unsubscribe();
      await watched.subscription.deliver([headUpdateEvent()]);

      expect(watched.batchTriggers).toEqual(['HEAD']);
    },
  );

  test.each(POSIX_PLATFORMS)(
    'on %s, a HEAD change the addon delivers while the native unsubscribe is in flight begins no batch',
    async (platform) => {
      const watched = await watchHead(platform);
      await beginLiveBatch(watched);

      watched.subscription.deliverWhileReleasing([headUpdateEvent()]);
      await watched.handle.unsubscribe();

      expect(watched.subscription.nativeReleases(), 'native unsubscribe calls').toBe(1);
      expect(watched.batchTriggers).toEqual(['HEAD']);
    },
  );

  test.each(POSIX_PLATFORMS)(
    'characterization: on %s, releasing the HEAD watcher unsubscribes the addon exactly once',
    async (platform) => {
      const { handle, subscription } = await watchHead(platform);

      await handle.unsubscribe();

      expect(subscription.nativeReleases(), 'native unsubscribe calls').toBe(1);
    },
  );
});
