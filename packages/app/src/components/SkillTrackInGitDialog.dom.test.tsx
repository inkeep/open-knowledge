import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

/**
 * The dialog that explains a gitignored skill and offers the one-line fix.
 *
 * Two properties are load-bearing, because this writes to the user's REPO:
 * it shows the literal `.gitignore` line before touching anything, and it only
 * writes on the explicit confirm. The line itself comes from the server (git
 * cannot re-include a file whose parent directory is excluded, so the rule has
 * to name the skills DIRECTORY) — the dialog must render what it is handed
 * rather than compose its own.
 */
const trackSkillInGit = vi.fn(async (input: { apply?: boolean }) => ({
  ok: true as const,
  line: '!/.claude/skills/',
  gitignorePath: '.gitignore',
  applied: input.apply === true,
}));
const openTarget = vi.fn();

vi.doMock('@/lib/skills-api', () => ({ trackSkillInGit }));
vi.doMock('@/editor/DocumentContext', () => ({ useDocumentContext: () => ({ openTarget }) }));
vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({ merged: { editor: { previewTabs: true } } }),
}));
vi.doMock('@/hooks/use-skills', () => ({
  useSkills: () => ({
    status: 'ready',
    data: [
      {
        scope: 'project',
        name: 'hidden',
        path: '.claude/skills/hidden/SKILL.md',
        installed: true,
        hosts: [],
        ignored: true,
      },
    ],
  }),
}));

const { SkillTrackInGitDialog } = await import('@/components/SkillTrackInGitDialog');
const { requestSkillTrackPrompt, __resetSkillTrackPromptForTests, getSkillTrackPrompt } =
  await import('@/lib/skill-track-prompt-store');

afterEach(() => {
  __resetSkillTrackPromptForTests();
  trackSkillInGit.mockClear();
  openTarget.mockClear();
});

describe('SkillTrackInGitDialog', () => {
  test('renders nothing until a skill asks for it', () => {
    render(<SkillTrackInGitDialog />);
    expect(screen.queryByTestId('skill-track-in-git-confirm')).toBeNull();
  });

  test('shows the exact .gitignore line and writes nothing before the confirm', async () => {
    requestSkillTrackPrompt({ scope: 'project', name: 'hidden' });
    render(<SkillTrackInGitDialog />);

    expect(await screen.findByText('!/.claude/skills/')).toBeTruthy();
    // Preview only: every call so far left `apply` off.
    expect(trackSkillInGit).toHaveBeenCalled();
    for (const [input] of trackSkillInGit.mock.calls) {
      expect(input.apply).not.toBe(true);
    }
  });

  test('a failed preview says so instead of leaving a dead button', async () => {
    // The dialog explains the fix, so disabling the only control that applies
    // it with no reason shown is the worst of both.
    trackSkillInGit.mockImplementationOnce(async () => ({
      ok: false as const,
      error: 'no project',
    }));
    requestSkillTrackPrompt({ scope: 'project', name: 'hidden' });
    render(<SkillTrackInGitDialog />);

    expect(await screen.findByText(/no project/)).toBeTruthy();
  });

  test('the confirm applies the rule and opens the skill it was blocking', async () => {
    requestSkillTrackPrompt({ scope: 'project', name: 'hidden' });
    render(<SkillTrackInGitDialog />);
    await screen.findByText('!/.claude/skills/');

    await userEvent.click(screen.getByTestId('skill-track-in-git-confirm'));

    expect(trackSkillInGit).toHaveBeenCalledWith({
      name: 'hidden',
      scope: 'project',
      apply: true,
    });
    // The user asked to OPEN the skill; the rule was only in the way. Addressed
    // by the entry's own doc name, not back through the opener whose `ignored`
    // guard is still true until the list refetches.
    expect(openTarget).toHaveBeenCalledWith(
      {
        kind: 'doc',
        target: '.claude/skills/hidden/SKILL',
        docName: '.claude/skills/hidden/SKILL',
      },
      // Threaded like every other skill open, so the preview-tab preference is
      // honoured instead of always stacking a permanent tab.
      { tabBehavior: 'replace-active' },
    );
    expect(getSkillTrackPrompt()).toBeNull();
  });
});
