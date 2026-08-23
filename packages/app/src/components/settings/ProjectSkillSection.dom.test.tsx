import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

// The row is fed by `/api/skills` — the same list every other skills surface
// reads — so the harness controls the hook rather than a desktop bridge. The
// bridge is not mocked at all here, which is itself part of the contract: this
// block used to render nothing without it.
let skillsState: { status: string; data?: readonly SkillsListEntry[]; message?: string } = {
  status: 'loading',
};
vi.doMock('@/hooks/use-skills', () => ({ useSkills: () => skillsState }));

const { ProjectSkillSection } = await import('./ProjectSkillSection');
const { TooltipProvider } = await import('@/components/ui/tooltip');

function renderSection() {
  return render(
    <TooltipProvider>
      <ProjectSkillSection />
    </TooltipProvider>,
  );
}

const projectSkill: SkillsListEntry = {
  name: 'open-knowledge',
  description:
    'Authoritative agent-runtime contract for working inside an OpenKnowledge project — a markdown-CRDT knowledge base exposed over MCP.',
  scope: 'project',
  path: '.claude/skills/open-knowledge/SKILL.md',
  absolutePath: '/proj/.claude/skills/open-knowledge/SKILL.md',
  installed: true,
  hosts: ['claude', 'codex'],
  managed: true,
  size: { alwaysOn: 140, onTrigger: 1495, onDemand: 0 },
};

/** An ordinary authored skill, present to prove the filter is scope + managed
 *  rather than "the first project entry". */
const authored: SkillsListEntry = {
  name: 'grill-me',
  scope: 'project',
  path: '.claude/skills/grill-me/SKILL.md',
  absolutePath: '/proj/.claude/skills/grill-me/SKILL.md',
  installed: true,
  hosts: ['claude'],
};

beforeEach(() => {
  skillsState = { status: 'ready', data: [authored, projectSkill] };
});

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('ProjectSkillSection', () => {
  test('renders the project skill row with its human blurb, not the frontmatter description', async () => {
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('settings-project-skill')).toBeTruthy();
    });
    expect(screen.getByText('How to use OpenKnowledge and its MCP tools.')).toBeTruthy();
    expect(screen.queryByText(/markdown-CRDT knowledge base/)).toBeNull();
    // One row: the authored project skill belongs to the manager below, not here.
    expect(screen.getAllByTestId('skill-consent-row-preview').length).toBe(1);
    expect(screen.queryByText('grill-me')).toBeNull();
  });

  test('the row is the control — there is no separate button to write from', async () => {
    // Settings owning a second write of the same state is what let one surface
    // say "installed" while the skill's own page said which agents. The row
    // hands off; it does not act.
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('settings-project-skill')).toBeTruthy();
    });
    expect(screen.queryByTestId('project-skill-install')).toBeNull();
    expect(screen.queryByTestId('project-skill-uninstall')).toBeNull();
  });

  test('clicking the row opens the built-in preview addressed by its bundle dir', async () => {
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('skill-consent-row-preview')).toBeTruthy();
    });
    // Settings is a hash-driven dialog (#settings); navigating to a preview hash
    // is exactly what dismisses it.
    window.location.hash = '#settings';

    await userEvent.click(screen.getByTestId('skill-consent-row-preview'));

    expect(window.location.hash.startsWith('#/__skill-preview__/')).toBe(true);
    // The bundle DIR, not the SKILL.md the list reports — a preview addressed at
    // the file resolves nothing.
    expect(decodeURIComponent(window.location.hash)).toContain(
      '/proj/.claude/skills/open-knowledge',
    );
    expect(decodeURIComponent(window.location.hash)).not.toContain('SKILL.md');
    // `level` is part of the preview tab's identity — a slip to 'global' here
    // still produces a working tab, but a SECOND one whenever the same skill is
    // also opened from a global surface.
    expect(decodeURIComponent(window.location.hash)).toMatch(/\/project$/);
  });

  test('leads with what the skill is for, then that it is committed to the repo', async () => {
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('settings-project-skill')).toBeTruthy();
    });
    const block = screen.getByTestId('settings-project-skill').textContent ?? '';
    // Same provenance heading as the user-scope block — both are skills OK
    // ships, so the heading must not split them across two axes.
    expect(block).toContain('Skills from OpenKnowledge');
    expect(block).toContain('how to work with OpenKnowledge');
    expect(block).toContain('everyone who opens the project');
  });

  test('no project open → renders nothing, leaving the folders block below', async () => {
    skillsState = { status: 'ready', data: [authored] };
    const { container } = renderSection();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="settings-project-skill"]')).toBeNull();
    });
  });

  test('a global built-in never lands in the project block', async () => {
    // Both blocks filter the SAME list, so a scope slip shows one skill twice on
    // one page.
    skillsState = {
      status: 'ready',
      data: [{ ...projectSkill, name: 'open-knowledge-discovery', scope: 'global' }],
    };
    const { container } = renderSection();
    await waitFor(() => {
      expect(container.querySelector('[data-testid="settings-project-skill"]')).toBeNull();
    });
  });

  test('a failed list keeps the heading and says what could not be read', async () => {
    skillsState = { status: 'error', message: 'boom' };
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('project-skill-unavailable')).toBeTruthy();
    });
    expect(screen.getByTestId('settings-project-skill').textContent).toContain(
      'Skills from OpenKnowledge',
    );
  });

  test('the loading state announces itself rather than showing a silent skeleton', async () => {
    skillsState = { status: 'loading' };
    renderSection();
    const loading = await screen.findByTestId('project-skill-loading');
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading.textContent).toContain('Loading skills');
  });
});
