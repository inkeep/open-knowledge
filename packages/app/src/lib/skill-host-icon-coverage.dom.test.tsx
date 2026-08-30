/**
 * Every skill-install target must render a visible mark.
 *
 * These brand icons double as the skill-host marks in the sidebar, the install
 * menu, and the editor's icon cluster. An id with no glyph does not degrade to
 * "row without a logo" — it degrades to an EMPTY `<span role="img">`, which
 * reads as "not installed at all", and to a zero-size tooltip trigger that
 * cannot be hovered.
 *
 * This is a lockstep guard, not a snapshot: adding an editor to
 * `EDITOR_USER_SKILL_ROOT` widens the install vocabulary automatically, and
 * nothing in the type system connects that map to the icon set (the cluster
 * casts through `as TargetIconId`). `lm-studio` shipped exactly that way.
 */
import { SkillUserTargetEditorSchema } from '@inkeep/open-knowledge-core';
import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { AgentBrandIcon } from '@/components/AgentIconCluster';

describe('skill host icon coverage', () => {
  test('every user-global install target renders its OWN mark', () => {
    // Stronger than presence, weaker than identity — state which. A bare
    // presence check goes green the moment any fallback glyph exists, so this
    // requires a non-empty ACCESSIBLE NAME: a nameless or fallback mark fails.
    // It does NOT pin which host the name belongs to, so a host wired to another
    // host's correctly-labelled icon would still pass. Cross-host mis-wiring is
    // caught by review, not here; what this pins is that no install target
    // renders an unnamed or absent mark.
    const wrong: string[] = [];
    for (const host of SkillUserTargetEditorSchema.options) {
      const { container, unmount } = render(<AgentBrandIcon host={host} />);
      const svg = container.querySelector('svg');
      const name =
        svg?.getAttribute('aria-label') ?? svg?.querySelector('title')?.textContent ?? '';
      if (svg === null || name.trim() === '') wrong.push(`${host}: no mark`);
      unmount();
    }
    expect(wrong).toEqual([]);
  });

  test('the vendor-neutral hub renders a mark too', () => {
    const { container } = render(<AgentBrandIcon host="agents" />);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
