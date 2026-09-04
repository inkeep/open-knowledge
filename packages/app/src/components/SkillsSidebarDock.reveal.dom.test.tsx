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
  writeSkillsDockExpanded(true);
  renderDock();
  expect(screen.getByTestId('skills-section').textContent).toBe('expanded');

  act(() => {
    requestSkillsDockExpanded();
  });

  expect(screen.getByTestId('skills-section').textContent).toBe('expanded');
});

test('the dock unsubscribes on unmount', () => {
  const before = __skillsDockListenerCountForTests();
  const { unmount } = renderDock();
  expect(__skillsDockListenerCountForTests()).toBeGreaterThan(before);

  unmount();

  expect(__skillsDockListenerCountForTests()).toBe(before);
  act(() => {
    requestSkillsDockExpanded();
  });
});
