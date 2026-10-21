import { RESCAN_NOTICES } from './parcel-recovery.ts';
import type { NativeWatcherBackend } from './parcel-subscription.ts';

type SubscribeArgs = Parameters<NativeWatcherBackend['subscribe']>;
type SubscribeCallback = SubscribeArgs[1];
type WatcherDoubleEvent = Parameters<SubscribeCallback>[1][number];

interface WatcherDoubleSubscription {
  readonly dir: string;
  readonly closed: boolean;
  readonly dead: boolean;
  deliver(events: WatcherDoubleEvent[]): void;
  fail(error: Error): void;
  rescan(events?: WatcherDoubleEvent[]): void;
}

export function createWatcherDouble(): {
  readonly backend: NativeWatcherBackend;
  subscriptionFor(dir: string): WatcherDoubleSubscription;
  subscriptionCount(dir: string): number;
  failNextSubscribe(dir: string, error: Error): void;
} {
  const subscriptions: WatcherDoubleSubscription[] = [];
  const subscribeFailures = new Map<string, Error[]>();
  const [rescanNotice] = RESCAN_NOTICES;
  const backend: NativeWatcherBackend = {
    async subscribe(dir, callback) {
      const failure = subscribeFailures.get(dir)?.shift();
      if (failure) throw failure;
      let closed = false;
      let dead = false;
      const subscription: WatcherDoubleSubscription = {
        dir,
        get closed() {
          return closed;
        },
        get dead() {
          return dead;
        },
        deliver(events) {
          if (!closed && !dead) callback(null, events);
        },
        fail(error) {
          if (closed || dead) return;
          dead = true;
          callback(error, []);
        },
        rescan(events = []) {
          if (!closed && !dead) callback(new Error(rescanNotice), events);
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
  const forDir = (dir: string): WatcherDoubleSubscription[] =>
    subscriptions.filter((subscription) => subscription.dir === dir);
  return {
    backend,
    subscriptionFor(dir) {
      const found = forDir(dir).at(-1);
      if (!found) {
        throw new Error(
          `no watcher double subscription for ${dir}; have ${subscriptions.map((s) => s.dir).join(', ') || 'none'}`,
        );
      }
      return found;
    },
    subscriptionCount(dir) {
      return forDir(dir).length;
    },
    failNextSubscribe(dir, error) {
      const queued = subscribeFailures.get(dir) ?? [];
      queued.push(error);
      subscribeFailures.set(dir, queued);
    },
  };
}
