import type { AsyncSubscription, Options, SubscribeCallback } from '@parcel/watcher';

export async function subscribeParcel(
  parcel: Pick<typeof import('@parcel/watcher'), 'subscribe'>,
  dir: string,
  onEvents: SubscribeCallback,
  options?: Options,
  platform: NodeJS.Platform = process.platform,
): Promise<AsyncSubscription> {
  let deliver: SubscribeCallback | null = onEvents;
  const subscription = await parcel.subscribe(
    dir,
    (err, events) => deliver?.(err, events),
    options,
  );
  return {
    async unsubscribe() {
      if (deliver === null) return;
      deliver = null;
      // UPSTREAM(parcel-bundler/watcher#262): the win32 native unsubscribe frees the subscription while its read's completion is still queued
      if (platform === 'win32') return;
      await subscription.unsubscribe();
    },
  };
}
