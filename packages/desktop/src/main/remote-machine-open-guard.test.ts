import { describe, expect, test } from 'bun:test';
import { RemoteMachineOpenGuard } from './remote-machine-open-guard.ts';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('RemoteMachineOpenGuard', () => {
  test('blocks mutation until every concurrent open for the machine settles', async () => {
    const guard = new RemoteMachineOpenGuard();
    const first = deferred<void>();
    const second = deferred<void>();
    const firstOpen = guard.run('machine-a', () => first.promise);
    const secondOpen = guard.run('machine-a', () => second.promise);

    expect(() => guard.assertMutable('machine-a')).toThrow(
      'Wait for this SSH machine to finish opening before changing it.',
    );
    expect(() => guard.assertMutable('machine-b')).not.toThrow();

    first.resolve();
    await firstOpen;
    expect(() => guard.assertMutable('machine-a')).toThrow(
      'Wait for this SSH machine to finish opening before changing it.',
    );

    second.resolve();
    await secondOpen;
    expect(() => guard.assertMutable('machine-a')).not.toThrow();
  });

  test('releases the machine when an open fails', async () => {
    const guard = new RemoteMachineOpenGuard();

    await expect(
      guard.run('machine-a', async () => {
        throw new Error('offline');
      }),
    ).rejects.toThrow('offline');

    expect(() => guard.assertMutable('machine-a')).not.toThrow();
  });
});
