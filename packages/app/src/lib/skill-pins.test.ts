import type { Config } from '@inkeep/open-knowledge-core';
import { describe, expect, it } from 'vitest';
import { PIN_FIELD, readPins, togglePin } from './skill-pins';

/**
 * Pins arrive from a hand-editable YAML file, so `readPins` is mostly guards:
 * the field can be absent, the wrong type, or hold blanks and duplicates that a
 * person typed. Each guard exists because the alternative is a crash or a
 * phantom pin on a skill named `""`.
 */
function config(sidebar: Record<string, unknown>): Config {
  return { appearance: { sidebar } } as unknown as Config;
}

describe('readPins', () => {
  it('reads each scope from its own field', () => {
    const c = config({
      [PIN_FIELD.project]: ['mine'],
      [PIN_FIELD.global]: ['ponytail'],
    });
    expect([...readPins(c, 'project')]).toEqual(['mine']);
    expect([...readPins(c, 'global')]).toEqual(['ponytail']);
  });

  it('is empty for absent config, absent field, and a non-array value', () => {
    expect(readPins(null, 'project').size).toBe(0);
    expect(readPins(undefined, 'global').size).toBe(0);
    expect(readPins(config({}), 'project').size).toBe(0);
    // Someone wrote `pinnedProjectSkills: mine` without the list syntax.
    expect(readPins(config({ [PIN_FIELD.project]: 'mine' }), 'project').size).toBe(0);
  });

  it('drops blanks, trims, and de-duplicates', () => {
    const c = config({ [PIN_FIELD.project]: ['  mine  ', '', '   ', 'mine', 'other'] });
    expect([...readPins(c, 'project')].sort()).toEqual(['mine', 'other']);
  });

  it('skips non-string entries rather than coercing them', () => {
    // A YAML list of numbers is a plausible typo; `42` is not a skill name.
    const c = config({ [PIN_FIELD.project]: ['mine', 42, null, { name: 'x' }] });
    expect([...readPins(c, 'project')]).toEqual(['mine']);
  });
});

describe('togglePin', () => {
  it('adds and removes', () => {
    expect(togglePin(new Set(['a']), 'b', true)).toEqual(['a', 'b']);
    expect(togglePin(new Set(['a', 'b']), 'a', false)).toEqual(['b']);
  });

  it('is idempotent in both directions', () => {
    expect(togglePin(new Set(['a']), 'a', true)).toEqual(['a']);
    expect(togglePin(new Set(['a']), 'b', false)).toEqual(['a']);
  });

  it('sorts numerically so the file does not churn on unrelated edits', () => {
    // Plain lexicographic would give skill-10 before skill-2 and rewrite the
    // list on every toggle; the point of sorting is a stable, reviewable file.
    expect(togglePin(new Set(['skill-10', 'skill-2']), 'skill-1', true)).toEqual([
      'skill-1',
      'skill-2',
      'skill-10',
    ]);
  });

  it('does not mutate the set it was given', () => {
    const current = new Set(['a']);
    togglePin(current, 'b', true);
    expect([...current]).toEqual(['a']);
  });
});
