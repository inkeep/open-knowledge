/**
 * PresenceBar — value/shape contract tests for the exported constants that
 * drive the writing-pulse min-duration behavior (UX polish).
 *
 * Repo convention (see NavigationPendingBar.test.ts header): UI helpers are
 * unit-tested at the pure-function altitude; full render + class-transition
 * behavior is covered by Playwright E2E — here, `multi-agent-presence.e2e.ts`.
 * A real hook test would require `@testing-library/react` + happy-dom, which
 * the workspace has deliberately stayed off.
 *
 * The constant-shape test is the tripwire for value drift: if a future edit
 * drops WRITING_PULSE_MIN_MS below the perceptual floor (≈500ms — where
 * `animate-pulse` would barely start) or raises it past a usability ceiling
 * (≈2s — where the pulse would linger into the next write and feel laggy),
 * this test fails.
 */

import { describe, expect, test } from 'bun:test';
import { ANIMAL_ICON_NAMES, pickHumanAvatarKind, WRITING_PULSE_MIN_MS } from './PresenceBar';

describe('WRITING_PULSE_MIN_MS', () => {
  test('is at least 500ms — below this, animate-pulse barely starts', () => {
    // Tailwind's `animate-pulse` uses a 2s cubic-bezier keyframe. The first
    // visible intensity change lands around 250-500ms into the cycle. Below
    // 500ms, the class is removed before the user perceives ANY animation.
    expect(WRITING_PULSE_MIN_MS).toBeGreaterThanOrEqual(500);
  });

  test('is at most 2000ms — beyond this, pulse lingers into the next write and feels laggy', () => {
    // The intent of the hold is "show a visible pulse per write." Holding
    // past the next write window (agents commonly burst-write in <1s bursts)
    // would make the pulse read as "always on" rather than "this write."
    expect(WRITING_PULSE_MIN_MS).toBeLessThanOrEqual(2000);
  });

  test('is not set to a value that exactly matches AGENT_PRESENCE_STALE_MS', () => {
    // AGENT_PRESENCE_STALE_MS is 5000 — the client TTL filter. The pulse
    // duration is a SEPARATE concern and should never be conflated. If a
    // refactor accidentally wires the pulse to the stale-MS constant, the
    // pulse would hold for 5s (too long) and couple two unrelated timings.
    expect(WRITING_PULSE_MIN_MS).not.toBe(5_000);
  });
});

describe('pickHumanAvatarKind', () => {
  test('git-config user (principalId set) always renders initials, even when name matches an animal', () => {
    // The "John Bird" rule — a real human whose surname coincides with an
    // ANIMAL_ICON_MAP key must never render an animal icon. The principalId
    // presence is the discriminator.
    const result = pickHumanAvatarKind({ name: 'John Bird', principalId: 'principal-jb' });
    expect(result).toEqual({ kind: 'initials' });
  });

  test('git-config user with empty-string principalId is treated as ineligible (renders animal if name matches)', () => {
    // Eligibility mirrors the dedupe rule in usePresence: empty string is
    // not a valid principalId. A user without a real principal who happens
    // to have a name matching an animal-key still renders the animal.
    const result = pickHumanAvatarKind({ name: 'Curious Bird', principalId: '' });
    expect(result).toEqual({ kind: 'animal', animal: 'Bird' });
  });

  test('synthesized fallback name with second word matching an animal key renders that animal', () => {
    const result = pickHumanAvatarKind({ name: 'Curious Squirrel' });
    expect(result).toEqual({ kind: 'animal', animal: 'Squirrel' });
  });

  test('synthesized fallback name whose second word does not match falls back to initials', () => {
    // Defensive: any random-name pool change that produces a non-mapped
    // second word must still render — initials cover it.
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
    // Tripwire: if a future commit drops the animal icon table, this test
    // catches it before the integration test fleet would notice.
    expect(ANIMAL_ICON_NAMES.length).toBeGreaterThan(0);
    expect(ANIMAL_ICON_NAMES).toContain('Bird');
    expect(ANIMAL_ICON_NAMES).toContain('Squirrel');
  });
});
