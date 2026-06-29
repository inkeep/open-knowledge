import { describe, expect, test } from 'bun:test';
import { ANIMAL_ICON_NAMES, pickHumanAvatarKind, WRITING_PULSE_MIN_MS } from './PresenceBar';

describe('WRITING_PULSE_MIN_MS', () => {
  test('is at least 500ms — below this, animate-pulse barely starts', () => {
    expect(WRITING_PULSE_MIN_MS).toBeGreaterThanOrEqual(500);
  });

  test('is at most 2000ms — beyond this, pulse lingers into the next write and feels laggy', () => {
    expect(WRITING_PULSE_MIN_MS).toBeLessThanOrEqual(2000);
  });

  test('is not set to a value that exactly matches AGENT_PRESENCE_STALE_MS', () => {
    expect(WRITING_PULSE_MIN_MS).not.toBe(5_000);
  });
});

describe('pickHumanAvatarKind', () => {
  test('git-config user (principalId set) always renders initials, even when name matches an animal', () => {
    const result = pickHumanAvatarKind({ name: 'John Bird', principalId: 'principal-jb' });
    expect(result).toEqual({ kind: 'initials' });
  });

  test('git-config user with empty-string principalId is treated as ineligible (renders animal if name matches)', () => {
    const result = pickHumanAvatarKind({ name: 'Curious Bird', principalId: '' });
    expect(result).toEqual({ kind: 'animal', animal: 'Bird' });
  });

  test('synthesized fallback name with second word matching an animal key renders that animal', () => {
    const result = pickHumanAvatarKind({ name: 'Curious Squirrel' });
    expect(result).toEqual({ kind: 'animal', animal: 'Squirrel' });
  });

  test('synthesized fallback name whose second word does not match falls back to initials', () => {
    const result = pickHumanAvatarKind({ name: 'Curious Phoenix' });
    expect(result).toEqual({ kind: 'initials' });
  });

  test('single-word name without principalId falls back to initials', () => {
    const result = pickHumanAvatarKind({ name: 'Solo' });
    expect(result).toEqual({ kind: 'initials' });
  });

  test('empty name returns initials (computeInitials handles the rendering)', () => {
    const result = pickHumanAvatarKind({ name: '' });
    expect(result).toEqual({ kind: 'initials' });
  });

  test('ANIMAL_ICON_NAMES is non-empty and contains the canonical animal-fallback set', () => {
    expect(ANIMAL_ICON_NAMES.length).toBeGreaterThan(0);
    expect(ANIMAL_ICON_NAMES).toContain('Bird');
    expect(ANIMAL_ICON_NAMES).toContain('Squirrel');
  });
});
