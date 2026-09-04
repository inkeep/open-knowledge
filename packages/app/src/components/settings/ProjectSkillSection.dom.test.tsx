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
    expect(screen.getAllByTestId('skill-consent-row-preview').length).toBe(1);
    expect(screen.queryByText('grill-me')).toBeNull();
  });

  test('the row is the control — there is no separate button to write from', async () => {
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
    window.location.hash = '#settings';

    await userEvent.click(screen.getByTestId('skill-consent-row-preview'));

    expect(window.location.hash.startsWith('#/__skill-preview__/')).toBe(true);
    expect(decodeURIComponent(window.location.hash)).toContain(
      '/proj/.claude/skills/open-knowledge',
    );
    expect(decodeURIComponent(window.location.hash)).not.toContain('SKILL.md');
    expect(decodeURIComponent(window.location.hash)).toMatch(/\/project$/);
  });

  test('leads with what the skill is for, then that it is committed to the repo', async () => {
    renderSection();
    await waitFor(() => {
      expect(screen.getByTestId('settings-project-skill')).toBeTruthy();
    });
    const block = screen.getByTestId('settings-project-skill').textContent ?? '';
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
