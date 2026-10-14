import { describe, expect, test } from 'vitest';
import {
  applyToggleAtEveryWidth,
  openIntentAfterPartitionChange,
  type PinStorage,
  readPins,
  resolveEffectiveState,
  SIDEBAR_PINS_KEY,
} from './sidebar-pin-store.ts';

function memoryStorage(initial: Record<string, string> = {}): PinStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      data.set(key, value);
    },
  };
}

describe('readPins', () => {
  test('absent key returns empty', () => {
    expect(readPins(memoryStorage())).toEqual({});
  });

  test('valid stored pins are returned', () => {
    const s = memoryStorage({
      [SIDEBAR_PINS_KEY]: JSON.stringify({ left: { above: 'collapsed' } }),
    });
    expect(readPins(s)).toEqual({ left: { above: 'collapsed' } });
  });

  test('multiple partition slots per side are returned', () => {
    const s = memoryStorage({
      [SIDEBAR_PINS_KEY]: JSON.stringify({
        right: { above: 'collapsed', below: 'open' },
      }),
    });
    expect(readPins(s)).toEqual({ right: { above: 'collapsed', below: 'open' } });
  });

  test('corrupt JSON falls back to empty', () => {
    const s = memoryStorage({ [SIDEBAR_PINS_KEY]: '{not valid json' });
    expect(readPins(s)).toEqual({});
  });

  test('wrong-type value falls back to empty', () => {
    const s = memoryStorage({ [SIDEBAR_PINS_KEY]: '"a string"' });
    expect(readPins(s)).toEqual({});
  });

  test('array value falls back to empty', () => {
    const s = memoryStorage({ [SIDEBAR_PINS_KEY]: '[1,2,3]' });
    expect(readPins(s)).toEqual({});
  });

  test('unknown partition key in slot bag drops the entire side', () => {
    const s = memoryStorage({
      [SIDEBAR_PINS_KEY]: JSON.stringify({
        left: { sideways: 'open' },
        right: { below: 'collapsed' },
      }),
    });
    const pins = readPins(s);
    expect(pins.left).toBeUndefined();
    expect(pins.right).toEqual({ below: 'collapsed' });
  });

  test('non-state value in slot bag drops the entire side', () => {
    const s = memoryStorage({
      [SIDEBAR_PINS_KEY]: JSON.stringify({
        left: { above: 'invalid-state' },
      }),
    });
    expect(readPins(s).left).toBeUndefined();
  });

  test('v1 single-slot shape is rejected (no migration)', () => {
    const s = memoryStorage({
      [SIDEBAR_PINS_KEY]: JSON.stringify({ left: { p: 'above', s: 'open' } }),
    });
    expect(readPins(s).left).toBeUndefined();
  });

  test('readPins returns empty when getItem throws (SecurityError / private browsing)', () => {
    const throwingStorage: PinStorage = {
      getItem: () => {
        throw new DOMException('SecurityError');
      },
      setItem: () => {},
    };
    expect(readPins(throwingStorage)).toEqual({});
  });
});

describe('resolveEffectiveState (Per-Partition Pins)', () => {
  test('no pin returns smart default for above', () => {
    expect(resolveEffectiveState('left', 'above', {})).toBe('open');
  });

  test('no pin returns smart default for below', () => {
    expect(resolveEffectiveState('right', 'below', {})).toBe('collapsed');
  });

  test('no pin returns smart default for embedded', () => {
    expect(resolveEffectiveState('left', 'embedded', {})).toBe('collapsed');
  });

  test('partition slot overrides smart default', () => {
    const pins = { left: { below: 'open' as const } };
    expect(resolveEffectiveState('left', 'below', pins)).toBe('open');
  });

  test('absent slot for current partition falls back to smart default', () => {
    const pins = { left: { above: 'collapsed' as const } };
    expect(resolveEffectiveState('left', 'below', pins)).toBe('collapsed');
    expect(resolveEffectiveState('left', 'embedded', pins)).toBe('collapsed');
  });

  test('sides are independent', () => {
    const pins = {
      left: { above: 'collapsed' as const },
      right: { below: 'open' as const },
    };
    expect(resolveEffectiveState('left', 'above', pins)).toBe('collapsed');
    expect(resolveEffectiveState('right', 'above', pins)).toBe('open');
    expect(resolveEffectiveState('left', 'below', pins)).toBe('collapsed');
    expect(resolveEffectiveState('right', 'below', pins)).toBe('open');
  });

  test('each partition slot is resolved independently for the same side', () => {
    const pins = {
      right: { above: 'collapsed' as const, below: 'open' as const },
    };
    expect(resolveEffectiveState('right', 'above', pins)).toBe('collapsed');
    expect(resolveEffectiveState('right', 'below', pins)).toBe('open');
    expect(resolveEffectiveState('right', 'embedded', pins)).toBe('collapsed');
  });
});

describe('applyToggleAtEveryWidth', () => {
  test('writes the same state to every partition of one side, replacing its earlier slots', () => {
    const s = memoryStorage({
      [SIDEBAR_PINS_KEY]: JSON.stringify({ left: { above: 'open' }, right: { below: 'open' } }),
    });
    applyToggleAtEveryWidth('left', 'collapsed', s);
    expect(readPins(s)).toEqual({
      left: { above: 'collapsed', below: 'collapsed', embedded: 'collapsed' },
      right: { below: 'open' },
    });
  });

  test('returns the merged pins even when storage.setItem throws (quota exceeded)', () => {
    const throwingStorage: PinStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('QuotaExceededError');
      },
    };
    expect(applyToggleAtEveryWidth('left', 'collapsed', throwingStorage)).toEqual({
      left: { above: 'collapsed', below: 'collapsed', embedded: 'collapsed' },
    });
  });
});

describe('openIntentAfterPartitionChange', () => {
  test('a pinned partition returns its pin', () => {
    expect(openIntentAfterPartitionChange('left', 'above', { left: { above: 'collapsed' } })).toBe(
      false,
    );
    expect(openIntentAfterPartitionChange('right', 'below', { right: { below: 'open' } })).toBe(
      true,
    );
  });

  test('an unpinned partition opens only where the default is open', () => {
    expect(openIntentAfterPartitionChange('left', 'above', {})).toBe(true);
    expect(openIntentAfterPartitionChange('left', 'below', {})).toBeUndefined();
    expect(openIntentAfterPartitionChange('right', 'embedded', {})).toBeUndefined();
  });
});
