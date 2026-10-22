import { resolve } from 'node:path';
import type { AsyncSubscription, Event, Options, SubscribeCallback } from '@parcel/watcher';

export interface NativeSubscriptionDouble {
  readonly dir: string;
  nativeReleases(): number;
  deliver(events: Event[], error?: Error | null): Promise<void>;
  deliverWhileReleasing(events: Event[], error?: Error | null): void;
}

interface Registration extends NativeSubscriptionDouble {
  readonly callback: SubscribeCallback;
  release(): Promise<void>;
}

const registrations: Registration[] = [];
const failingReleases = new Set<string>();

function register(dir: string, callback: SubscribeCallback): Registration {
  let releases = 0;
  const queuedForRelease: Array<{ events: Event[]; error: Error | null }> = [];
  const deliver = async (events: Event[], error: Error | null = null): Promise<void> => {
    await callback(error, events);
    await new Promise<void>((settle) => setImmediate(settle));
  };
  return {
    dir,
    callback,
    nativeReleases: () => releases,
    deliver,
    deliverWhileReleasing: (events, error = null) => {
      queuedForRelease.push({ events, error });
    },
    release: async () => {
      releases += 1;
      for (const { events, error } of queuedForRelease.splice(0)) await deliver(events, error);
      if (failingReleases.delete(dir)) {
        throw new Error(`the watcher double failed to release ${dir}`);
      }
    },
  };
}

const refusals = new Map<string, number>();

const parcelWatcherDouble = {
  subscribe(
    dir: string,
    callback: SubscribeCallback,
    _options?: Options,
  ): Promise<AsyncSubscription> {
    const refused = refusals.get(resolve(dir)) ?? 0;
    if (refused > 0) {
      refusals.set(resolve(dir), refused - 1);
      return Promise.reject(new Error(`the watcher double refused to watch ${dir}`));
    }
    const registration = register(resolve(dir), callback);
    registrations.push(registration);
    return Promise.resolve({ unsubscribe: () => registration.release() });
  },
  unsubscribe(dir: string, callback: SubscribeCallback, _options?: Options): Promise<void> {
    const registration = registrations.find(
      (candidate) => candidate.dir === resolve(dir) && candidate.callback === callback,
    );
    return registration === undefined ? Promise.resolve() : registration.release();
  },
};

export const parcelWatcherModule = { default: parcelWatcherDouble, ...parcelWatcherDouble };

export function forgetNativeSubscriptions(): void {
  registrations.length = 0;
  refusals.clear();
  failingReleases.clear();
}

export function failNextNativeRelease(dir: string): void {
  failingReleases.add(resolve(dir));
}

export function refuseNativeSubscriptions(dir: string, count: number): void {
  refusals.set(resolve(dir), count);
}

export function nativeSubscriptionCount(dir: string): number {
  return registrations.filter((registration) => registration.dir === dir).length;
}

export function latestNativeSubscriptionOn(dir: string): NativeSubscriptionDouble {
  const latest = registrations.filter((registration) => registration.dir === dir).at(-1);
  if (!latest) throw new Error(`no native subscription on ${dir}`);
  return latest;
}

export function nativeSubscriptionDirs(): string[] {
  return registrations.map((registration) => registration.dir);
}

export function nativeSubscriptionOn(dir: string): NativeSubscriptionDouble {
  const matching = registrations.filter((registration) => registration.dir === dir);
  if (matching.length !== 1) {
    throw new Error(
      `expected exactly one native subscription on ${dir}; the addon was asked to watch [${nativeSubscriptionDirs().join(', ')}]`,
    );
  }
  return matching[0];
}
