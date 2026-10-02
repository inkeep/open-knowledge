import { afterEach, expect, test, vi } from 'vitest';
import { pollSettledReading, RAIL_LAYOUT_SETTLE_TIMEOUT_MS } from './settled-reading';

afterEach(() => vi.useRealTimers());

test.each([
  ['zero', 0],
  ['negative', -1],
  ['not a number', Number.NaN],
  ['infinite', Number.POSITIVE_INFINITY],
] as const)('a %s deadline cannot disable the poll bound', (_name, timeout) => {
  expect(() =>
    pollSettledReading(() => Promise.resolve(1), {
      reading: 'dimension',
      of: 'test surface',
      timeout,
    }),
  ).toThrow('positive, finite timeout');
});

test('a reading completed after its declared bound cannot turn the verdict into success', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const started = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<string>();
  const result = pollSettledReading(
    () => {
      started.resolve();
      return reading.promise;
    },
    {
      reading: 'dimension',
      of: 'test surface',
      timeout: RAIL_LAYOUT_SETTLE_TIMEOUT_MS,
    },
  )
    .toBe('ready')
    .then(
      () => 'settled',
      (error: unknown) => error,
    );
  await started.promise;
  await vi.advanceTimersByTimeAsync(RAIL_LAYOUT_SETTLE_TIMEOUT_MS + 1);
  reading.resolve('ready');
  await vi.runAllTimersAsync();

  expect(await result).toBeInstanceOf(Error);
});

test('a synchronous reader failure is preserved even if another attempt could succeed', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const failure = new Error('dimension reader failed');
  let failed = false;
  const result = pollSettledReading(
    () => {
      if (!failed) {
        failed = true;
        throw failure;
      }
      return Promise.resolve(1);
    },
    {
      reading: 'dimension',
      of: 'test surface',
      timeout: RAIL_LAYOUT_SETTLE_TIMEOUT_MS,
    },
  )
    .toBe(1)
    .then(
      () => 'settled',
      (error: unknown) => error,
    );
  await vi.runAllTimersAsync();

  expect(await result).toMatchObject({ message: expect.stringContaining(failure.message) });
});
