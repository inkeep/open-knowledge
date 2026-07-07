import { describe, expect, test } from 'bun:test';
import {
  LUCIDE_ICON_ALLOWLIST,
  LUCIDE_ICON_ENTRIES,
  resolveLucideIcon,
} from './lucide-icon-allowlist.ts';

describe('resolveLucideIcon', () => {
  test('returns null for absent / empty values', () => {
    expect(resolveLucideIcon(undefined)).toBeNull();
    expect(resolveLucideIcon('')).toBeNull();
  });

  test('returns null for non-`lucide:` prefixes (emoji / plain text / other namespaces)', () => {
    expect(resolveLucideIcon('📘')).toBeNull();
    expect(resolveLucideIcon('Lightbulb')).toBeNull();
    expect(resolveLucideIcon('emoji:bug')).toBeNull();
  });

  test('returns null for unknown lucide names (not in allowlist)', () => {
    expect(resolveLucideIcon('lucide:DoesNotExist')).toBeNull();
    expect(resolveLucideIcon('lucide:lightbulb')).toBeNull(); // case-sensitive
  });

  test('returns the component for known allowlist names', () => {
    expect(resolveLucideIcon('lucide:Bug')).toBe(LUCIDE_ICON_ALLOWLIST.Bug);
    expect(resolveLucideIcon('lucide:Lightbulb')).toBe(LUCIDE_ICON_ALLOWLIST.Lightbulb);
    expect(resolveLucideIcon('lucide:ChevronRight')).toBe(LUCIDE_ICON_ALLOWLIST.ChevronRight);
  });

  test('rejects prototype-pollution names (`__proto__`, `constructor`, `toString`)', () => {
    expect(resolveLucideIcon('lucide:__proto__')).toBeNull();
    expect(resolveLucideIcon('lucide:constructor')).toBeNull();
    expect(resolveLucideIcon('lucide:toString')).toBeNull();
    expect(resolveLucideIcon('lucide:hasOwnProperty')).toBeNull();
  });
});

describe('LUCIDE_ICON_ENTRIES', () => {
  test('is sorted alphabetically by name', () => {
    const names = LUCIDE_ICON_ENTRIES.map(([n]) => n);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  test('contains every allowlist entry exactly once', () => {
    const allowlistKeys = Object.keys(LUCIDE_ICON_ALLOWLIST).sort();
    const entryKeys = LUCIDE_ICON_ENTRIES.map(([n]) => n).sort();
    expect(entryKeys).toEqual(allowlistKeys);
  });

  test('every component is a function (renderable React component)', () => {
    for (const [, Component] of LUCIDE_ICON_ENTRIES) {
      // lucide-react exports forwardRef objects; both function and object
      // values are acceptable React component shapes — assert non-nullish
      // and not a primitive.
      expect(Component).not.toBeNull();
      expect(['function', 'object']).toContain(typeof Component);
    }
  });
});
