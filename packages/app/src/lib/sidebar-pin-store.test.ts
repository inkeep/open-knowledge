import { describe, expect, test } from 'bun:test';
import {
  applyToggle,
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

  // Browser-storage trust boundary: localStorage.getItem can throw SecurityError
  // in Safari private browsing (and equivalent modes in other engines). The
  // readPins try/catch is the producer-cannot-enforce surface for that throw —
  // pin the fallback to {} via the public PinStorage seam.
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

describe('applyToggle (per-partition slot)', () => {
  test('sets slot for current partition', () => {
    const s = memoryStorage();
    applyToggle('left', 'above', 'collapsed', s);
    expect(readPins(s)).toEqual({ left: { above: 'collapsed' } });
  });

  test('toggling in a NEW partition preserves the existing slot for the OTHER partition', () => {
    const s = memoryStorage();
    applyToggle('left', 'above', 'collapsed', s);
    applyToggle('left', 'below', 'open', s);
    expect(readPins(s)).toEqual({
      left: { above: 'collapsed', below: 'open' },
    });
  });

  test('toggling the SAME partition overwrites only that slot', () => {
    const s = memoryStorage();
    applyToggle('left', 'above', 'collapsed', s);
    applyToggle('left', 'above', 'open', s);
    expect(readPins(s)).toEqual({ left: { above: 'open' } });
  });

  test('embedded slot is independent from above/below', () => {
    const s = memoryStorage();
    applyToggle('left', 'above', 'collapsed', s);
    applyToggle('left', 'below', 'open', s);
    applyToggle('left', 'embedded', 'open', s);
    expect(readPins(s)).toEqual({
      left: { above: 'collapsed', below: 'open', embedded: 'open' },
    });
  });

  test('toggle on one side does not affect the other', () => {
    const s = memoryStorage();
    applyToggle('left', 'above', 'collapsed', s);
    applyToggle('right', 'below', 'open', s);
    expect(readPins(s)).toEqual({
      left: { above: 'collapsed' },
      right: { below: 'open' },
    });
  });

  test('scenario: pin-then-cross-threshold uses smart default for new partition', () => {
    const s = memoryStorage();
    applyToggle('left', 'above', 'collapsed', s);
    const pins = readPins(s);
    expect(resolveEffectiveState('left', 'below', pins)).toBe('collapsed');
  });

  test('scenario: pin in narrow survives a wide round-trip (the D13 canary)', () => {
    const s = memoryStorage();
    // Pin right OPEN at narrow.
    applyToggle('right', 'below', 'open', s);
    // Resize wide; user toggles right COLLAPSED at wide. Should NOT clear below.
    applyToggle('right', 'above', 'collapsed', s);
    // Resize back to narrow — below slot must still hold the original 'open'.
    const pins = readPins(s);
    expect(resolveEffectiveState('right', 'below', pins)).toBe('open');
    expect(resolveEffectiveState('right', 'above', pins)).toBe('collapsed');
    expect(pins).toEqual({
      right: { above: 'collapsed', below: 'open' },
    });
  });

  // Browser-storage trust boundary: localStorage.setItem can throw
  // QuotaExceededError when origin storage is full. The writePins try/catch
  // preserves the in-memory result so the session keeps working even when
  // persistence fails — pin that contract via the public PinStorage seam.
  test('applyToggle returns the merged pins even when storage.setItem throws (quota exceeded)', () => {
    const throwingStorage: PinStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('QuotaExceededError');
      },
    };
    const result = applyToggle('left', 'above', 'collapsed', throwingStorage);
    expect(result).toEqual({ left: { above: 'collapsed' } });
  });
});
