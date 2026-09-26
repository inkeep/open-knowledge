import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AsyncSubscription, Event } from '@parcel/watcher';
import { beforeEach, describe, expect, test } from 'vitest';
import { subscribeParcel } from './parcel-subscription.ts';
import {
  forgetNativeSubscriptions,
  type NativeSubscriptionDouble,
  nativeSubscriptionOn,
  parcelWatcherModule,
} from './parcel-watcher-double.test-helper.ts';

const POSIX_PLATFORMS = ['linux', 'darwin'] as const satisfies readonly NodeJS.Platform[];
const PLATFORMS = ['win32', ...POSIX_PLATFORMS] as const satisfies readonly NodeJS.Platform[];
const NATIVE_RELEASES_PER_RELEASE = [
  ['win32', 0],
  ['linux', 1],
  ['darwin', 1],
] as const satisfies readonly (readonly [NodeJS.Platform, number])[];
const WATCHED_DIR = join(tmpdir(), 'ok-parcel-subscription');

beforeEach(() => {
  forgetNativeSubscriptions();
});

interface Subscribed {
  readonly subscription: AsyncSubscription;
  readonly native: NativeSubscriptionDouble;
  readonly delivered: Event[][];
}

async function subscribeOn(platform?: NodeJS.Platform): Promise<Subscribed> {
  const delivered: Event[][] = [];
  const subscription = await subscribeParcel(
    parcelWatcherModule,
    WATCHED_DIR,
    (_err, events) => {
      delivered.push(events);
    },
    undefined,
    platform,
  );
  return { subscription, native: nativeSubscriptionOn(WATCHED_DIR), delivered };
}

function created(name: string): Event {
  return { type: 'create', path: join(WATCHED_DIR, name) };
}

async function deliverLive(subscribed: Subscribed): Promise<void> {
  await subscribed.native.deliver([created('before.md')]);
  expect(subscribed.delivered, 'live delivery').toEqual([[created('before.md')]]);
}

describe('releasing a subscription taken through subscribeParcel', () => {
  test.each(NATIVE_RELEASES_PER_RELEASE)(
    'on %s, a release asks the addon to unsubscribe natively %i time(s)',
    async (platform, nativeReleases) => {
      const { subscription, native } = await subscribeOn(platform);

      await subscription.unsubscribe();

      expect(native.nativeReleases(), 'native unsubscribe calls').toBe(nativeReleases);
    },
  );

  test.each(PLATFORMS)(
    'on %s, a batch the addon delivers after the release reaches no consumer',
    async (platform) => {
      const subscribed = await subscribeOn(platform);
      await deliverLive(subscribed);

      await subscribed.subscription.unsubscribe();
      await subscribed.native.deliver([created('after.md')]);

      expect(subscribed.delivered).toEqual([[created('before.md')]]);
    },
  );

  test.each(POSIX_PLATFORMS)(
    'on %s, a batch the addon delivers while the native unsubscribe is in flight reaches no consumer',
    async (platform) => {
      const subscribed = await subscribeOn(platform);
      await deliverLive(subscribed);

      subscribed.native.deliverWhileReleasing([created('during.md')]);
      await subscribed.subscription.unsubscribe();

      expect(subscribed.native.nativeReleases(), 'native unsubscribe calls').toBe(1);
      expect(subscribed.delivered).toEqual([[created('before.md')]]);
    },
  );

  test.each(POSIX_PLATFORMS)(
    'on %s, a second release asks the addon for nothing more',
    async (platform) => {
      const { subscription, native } = await subscribeOn(platform);

      await subscription.unsubscribe();
      await subscription.unsubscribe();

      expect(native.nativeReleases(), 'native unsubscribe calls').toBe(1);
    },
  );

  test('without a platform, the host platform decides whether a release unsubscribes natively', async () => {
    const { subscription, native } = await subscribeOn();

    await subscription.unsubscribe();

    expect(native.nativeReleases(), 'native unsubscribe calls').toBe(
      process.platform === 'win32' ? 0 : 1,
    );
  });
});
