import { RESCAN_NOTICES } from './parcel-recovery.ts';
import type { NativeWatcherBackend } from './parcel-subscription.ts';

type SubscribeArgs = Parameters<NativeWatcherBackend['subscribe']>;
type SubscribeCallback = SubscribeArgs[1];
type WatcherDoubleEvent = Parameters<SubscribeCallback>[1][number];

interface WatcherDoubleSubscription {
  readonly dir: string;
  readonly closed: boolean;
  deliver(events: WatcherDoubleEvent[]): void;
  fail(error: Error): void;
  rescan(events?: WatcherDoubleEvent[]): void;
}

export function createWatcherDouble(): {
  readonly backend: NativeWatcherBackend;
  subscriptionFor(dir: string): WatcherDoubleSubscription;
} {
  const subscriptions: WatcherDoubleSubscription[] = [];
  const [rescanNotice] = RESCAN_NOTICES;
  const backend: NativeWatcherBackend = {
    async subscribe(dir, callback) {
      let closed = false;
      const subscription: WatcherDoubleSubscription = {
        dir,
        get closed() {
          return closed;
        },
        deliver(events) {
          if (!closed) callback(null, events);
        },
        fail(error) {
          if (!closed) callback(error, []);
        },
        rescan(events = []) {
          if (!closed) callback(new Error(rescanNotice), events);
        },
      };
      subscriptions.push(subscription);
      return {
        async unsubscribe() {
          closed = true;
        },
      };
    },
  };
  return {
    backend,
    subscriptionFor(dir) {
      const found = subscriptions.find((subscription) => subscription.dir === dir);
      if (!found) {
        throw new Error(
          `no watcher double subscription for ${dir}; have ${subscriptions.map((s) => s.dir).join(', ') || 'none'}`,
        );
      }
      return found;
    },
  };
}
