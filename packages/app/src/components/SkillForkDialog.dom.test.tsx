/**
 * the fork-resolution dialog must never hang on "Loading both
 * versions". The diff is a preview aid, not a gate — if a version preview fails
 * to load (fetch error) or the skill has no `absolutePath` to locate the dirs,
 * the dialog surfaces that and keeps the three resolve actions usable, instead
 * of an indefinite spinner. Runs under jsdom via `test:dom`.
 */
import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Radix Dialog focus-trap reaches for DOM globals the shared jsdom preload
// doesn't expose — same local shims as the sibling dialog dom tests.
type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const g = globalThis as GlobalWithDomShims;
if (g.NodeFilter === undefined && g.window?.NodeFilter !== undefined)
  g.NodeFilter = g.window.NodeFilter;
if (g.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  g.ResizeObserver = NoopResizeObserver;
}

const fetchSkillPreviewMock = vi.fn();
const resolveSkillForkMock = vi.fn(async () => ({ ok: true as const }));
vi.doMock('@/lib/skills-api', () => ({
  fetchSkillPreview: fetchSkillPreviewMock,
  resolveSkillFork: resolveSkillForkMock,
}));

const { SkillForkDialog } = await import('./SkillForkDialog.tsx');

const skill = {
  scope: 'project',
  name: 'plannotator-annotate',
  path: '.claude/skills/plannotator-annotate/SKILL.md',
  absolutePath: '/proj/.claude/skills/plannotator-annotate/SKILL.md',
} as unknown as SkillsListEntry;

describe('SkillForkDialog — never hangs on Loading (PRD-7608)', () => {
  afterEach(() => {
    cleanup();
    fetchSkillPreviewMock.mockReset();
    resolveSkillForkMock.mockReset();
  });

  test('a failed version preview shows an error + keeps the resolve actions', async () => {
    fetchSkillPreviewMock.mockResolvedValue({ ok: false });
    render(<SkillForkDialog target={{ skill, editor: 'claude' }} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.queryByText(/Couldn't load the version preview/i)).not.toBeNull();
    });
    // Not stuck on the spinner…
    expect(screen.queryByText(/Loading both versions/i)).toBeNull();
    // …and the three resolve actions are still usable.
    expect(screen.getByRole('button', { name: /keep source/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /use claude version/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /keep both/i })).toBeTruthy();
  });

  test('a missing absolutePath shows the error immediately, not a spinner', async () => {
    fetchSkillPreviewMock.mockResolvedValue({ ok: true, skillMd: '# x' });
    const noPath = { ...skill, absolutePath: undefined } as unknown as SkillsListEntry;
    render(
      <SkillForkDialog target={{ skill: noPath, editor: 'claude' }} onOpenChange={() => {}} />,
    );

    expect(screen.getByText(/Couldn't load the version preview/i)).toBeTruthy();
    expect(screen.queryByText(/Loading both versions/i)).toBeNull();
    // No fetch is even attempted when the dirs can't be located.
    expect(fetchSkillPreviewMock).not.toHaveBeenCalled();
  });
});
