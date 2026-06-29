import { describe, expect, test } from 'bun:test';
import {
  isPressureLevel,
  type PressureLevel,
  type PressureSample,
  readPressureLevel,
  readPressureSample,
  samplePressureDuring,
} from './macos-pressure';

const onMacOs = process.platform === 'darwin';

describe('isPressureLevel', () => {
  test.each([
    [1, true],
    [2, true],
    [4, true],
    [0, false],
    [3, false],
    [5, false],
    [-1, false],
    [Number.NaN, false],
  ])('isPressureLevel(%p) === %p', (value, expected) => {
    expect(isPressureLevel(value)).toBe(expected);
  });
});

describe('readPressureSample', () => {
  test.skipIf(!onMacOs)(
    'on macOS, returns a sample with level in {1,2,4} and platform=macos',
    async () => {
      const sample = await readPressureSample();
      expect(sample.platform).toBe('macos');
      expect([1, 2, 4]).toContain(sample.level);
      expect(typeof sample.capturedAt).toBe('string');
      expect(sample.error).toBeUndefined();
    },
  );

  test.skipIf(onMacOs)(
    'on non-macOS, returns level=1, platform=non-macos, error.code=unsupported-platform',
    async () => {
      const sample = await readPressureSample();
      expect(sample.platform).toBe('non-macos');
      expect(sample.level).toBe(1);
      expect(sample.error?.code).toBe('unsupported-platform');
    },
  );

  test('capturedAt is a parseable ISO timestamp', async () => {
    const before = Date.now();
    const sample = await readPressureSample();
    const parsed = Date.parse(sample.capturedAt);
    const after = Date.now();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after + 1);
  });
});

describe('readPressureLevel', () => {
  test('returns one of {1, 2, 4} on any platform', async () => {
    const level = await readPressureLevel();
    expect([1, 2, 4]).toContain(level);
  });

  test.skipIf(!onMacOs)('on macOS, level matches readPressureSample().level', async () => {
    const direct = await readPressureLevel();
    const fromSample = (await readPressureSample()).level;
    expect([1, 2, 4]).toContain(direct);
    expect([1, 2, 4]).toContain(fromSample);
  });

  test.skipIf(onMacOs)('on non-macOS, level is the safe default 1', async () => {
    const level = await readPressureLevel();
    expect(level).toBe(1);
  });
});

describe('samplePressureDuring', () => {
  test('first and last samples always recorded; result threaded through', async () => {
    const { result, samples, maxLevel } = await samplePressureDuring(
      { intervalMs: 10_000 },
      async () => {
        return 'computed';
      },
    );
    expect(result).toBe('computed');
    expect(samples.length).toBeGreaterThanOrEqual(2);
    expect([1, 2, 4]).toContain(maxLevel);
  });

  test('extra samples land when fn outlasts intervalMs', async () => {
    const { samples } = await samplePressureDuring({ intervalMs: 30 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(samples.length).toBeGreaterThan(2);
  });

  test('maxLevel is the worst observed sample (not the last)', async () => {
    const { maxLevel } = await samplePressureDuring({ intervalMs: 30 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect([1, 2, 4]).toContain(maxLevel);
  });

  test('maxLevel reducer picks the worst across heterogeneous samples', () => {
    const synthetic: ReadonlyArray<PressureSample> = [
      { level: 1, platform: 'macos', capturedAt: '2026-01-01T00:00:00Z' },
      { level: 2, platform: 'macos', capturedAt: '2026-01-01T00:00:01Z' },
      { level: 1, platform: 'macos', capturedAt: '2026-01-01T00:00:02Z' },
      { level: 4, platform: 'macos', capturedAt: '2026-01-01T00:00:03Z' },
      { level: 2, platform: 'macos', capturedAt: '2026-01-01T00:00:04Z' },
    ];
    const max = synthetic.reduce<PressureLevel>(
      (acc, sample) => (sample.level > acc ? sample.level : acc),
      1,
    );
    expect(max).toBe(4);
  });

  test('errors thrown by fn propagate to the caller', async () => {
    let caught: unknown;
    try {
      await samplePressureDuring({ intervalMs: 1000 }, async () => {
        throw new Error('cell-blew-up');
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('cell-blew-up');
  });

  test('intervalMs defaults to 1000 when omitted', async () => {
    const { samples } = await samplePressureDuring({}, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(samples.length).toBeGreaterThanOrEqual(2);
  });
});
