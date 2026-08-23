/**
 * The dock reveals itself when something OUTSIDE it asks the store to.
 *
 * The dock reads the store once at mount, so without the subscription it would
 * only ever observe its own clicks — the command palette's Skills entry and an
 * unresolved `/skill-name` link, which both reveal the dock rather than opening a
 * page, would set the stored value and change nothing on screen. That is a silent
 * failure with no error to notice, which is why it is pinned here.
 *
 * `SkillsSidebarSection` is stubbed at the module boundary: it fetches the skills
 * list and every bundle's files on expand, none of which this seam is about. The
 * real Radix Collapsible renders, so "revealed" is asserted the way a user
 * experiences it — the content is mounted and the trigger reports expanded.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

vi.mock('@/components/SkillsSidebarSection', () => ({
  SkillsSidebarSection: ({ dockExpanded }: { dockExpanded: boolean }) => (
    <div data-testid="skills-section">{dockExpanded ? 'expanded' : 'collapsed'}</div>
  ),
}));
vi.mock('@/hooks/use-create-blank-skill', () => ({
  useCreateBlankSkill: () => ({ createBlank: vi.fn() }),
}));
vi.mock('@/hooks/use-open-skill', () => ({ useOpenSkill: () => vi.fn() }));

const { SkillsSidebarDock } = await import('./SkillsSidebarDock');
const {
  __resetSkillsDockExpandedForTests,
  __skillsDockListenerCountForTests,
  requestSkillsDockExpanded,
  writeSkillsDockExpanded,
} = await import('./skills-dock-expanded-store');

afterEach(() => {
  cleanup();
  __resetSkillsDockExpandedForTests();
});

function renderDock() {
  return render(
    <TooltipProvider>
      <SkillsSidebarDock />
    </TooltipProvider>,
  );
}

test('an outside reveal request expands the mounted dock', () => {
  renderDock();
  expect(screen.queryByTestId('skills-section')).toBeNull();

  act(() => {
    requestSkillsDockExpanded();
  });

  expect(screen.getByTestId('skills-section').textContent).toBe('expanded');
});

test('a reveal while already expanded is a no-op, not a toggle', () => {
  // The store short-circuits an unchanged write, so no listener fires and the
  // dock stays open. A subscription wired to toggle instead of assign would
  // close the dock here — the exact bug a user hits by asking twice.
  writeSkillsDockExpanded(true);
  renderDock();
  expect(screen.getByTestId('skills-section').textContent).toBe('expanded');

  act(() => {
    requestSkillsDockExpanded();
  });

  expect(screen.getByTestId('skills-section').textContent).toBe('expanded');
});

test('the dock unsubscribes on unmount', () => {
  // React 19 silently ignores setState on an unmounted component, so a leaked
  // subscription throws nothing — the listener COUNT is the only assertion that
  // actually fails when the cleanup is dropped.
  const before = __skillsDockListenerCountForTests();
  const { unmount } = renderDock();
  expect(__skillsDockListenerCountForTests()).toBeGreaterThan(before);

  unmount();

  expect(__skillsDockListenerCountForTests()).toBe(before);
  // And the store still works with no mounted listener.
  act(() => {
    requestSkillsDockExpanded();
  });
});
