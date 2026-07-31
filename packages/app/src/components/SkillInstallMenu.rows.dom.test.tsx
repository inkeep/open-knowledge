import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

/**
 * What an install-menu ROW does and says.
 *
 * A row is a plain checkbox: click installs, click again removes, and nothing
 * else on the row changes underneath the click. Its hint is the only place that
 * contract is written down, and a native `title` does not render at all while
 * the window is unfocused, so the hints come from Radix.
 */
vi.mock('@/hooks/use-skills', () => ({ useSkills: () => ({ status: 'idle' }) }));

const { SkillInstallMenuItems } = await import('./SkillInstallMenu');
const { DropdownMenu, DropdownMenuContent } = await import('@/components/ui/dropdown-menu');
const { TooltipProvider } = await import('@/components/ui/tooltip');

const toggles = {
  hostSet: new Set(['claude', 'codex']),
  installed: true,
  installing: false,
  toggleEditor: vi.fn(),
  installAll: vi.fn(),
  linkMode: true,
  setSource: vi.fn(),
  placeAt: vi.fn(),
  convertLocation: vi.fn(),
  sourceHost: 'claude',
};

const skill = {
  scope: 'project',
  name: 'demo',
  hosts: ['claude', 'codex'],
  symlinkedHosts: ['codex'],
  path: '.claude/skills/demo/SKILL.md',
};

function renderMenu() {
  render(
    <TooltipProvider>
      <DropdownMenu open>
        <DropdownMenuContent>
          <SkillInstallMenuItems toggles={toggles as never} skill={skill as never} />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>,
  );
}

describe('install menu rows', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test('a row is a checkbox: it toggles install, and never moves the source', async () => {
    renderMenu();
    // Checked = installed, unchecked = not. No third state to cycle through.
    expect(screen.getByTestId('skill-install-editor-codex')).toHaveProperty('ariaChecked', 'true');
    expect(screen.getByTestId('skill-install-editor-cursor')).toHaveProperty(
      'ariaChecked',
      'false',
    );

    await userEvent.click(screen.getByTestId('skill-install-editor-cursor'));
    expect(toggles.toggleEditor).toHaveBeenCalledWith('cursor', true);
    // Clicking the row used to be able to land on the mode tag, which moved the
    // skill's real folder — the flash of `copy` settling on `source`.
    expect(toggles.setSource).not.toHaveBeenCalled();
    expect(toggles.convertLocation).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('skill-install-editor-codex'));
    expect(toggles.toggleEditor).toHaveBeenCalledWith('codex', false);
  });

  test('"All" is an explicit control of its own, not a row', async () => {
    renderMenu();
    await userEvent.click(screen.getByTestId('skill-install-all'));
    expect(toggles.installAll).toHaveBeenCalledTimes(1);
  });

  test('a row whose form matches the skill carries no mode tag to mis-click', () => {
    renderMenu();
    // codex is a symlink and so is the rest of the skill: nothing to say.
    expect(screen.queryByTestId('skill-convert-codex')).toBeNull();
    // Set-source is still reachable, but as its own labelled control.
    expect(screen.getByTestId('skill-set-source-codex').textContent).toBe('make source');
  });

  test('an installed row says clicking it removes the skill, via a tooltip', async () => {
    renderMenu();
    const row = screen.getByTestId('skill-install-editor-codex');
    // A native title would be the regression this replaced.
    expect(row.getAttribute('title')).toBeNull();

    await userEvent.hover(row);
    const hint = await screen.findByRole('tooltip');
    expect(hint.textContent).toContain('.codex/skills/demo');
    expect(hint.textContent).toContain('click to remove');
  });

  test('an empty row names the path the install would land at', async () => {
    renderMenu();
    const row = screen.getByTestId('skill-install-editor-cursor');
    expect(row.getAttribute('title')).toBeNull();

    await userEvent.hover(row);
    const hint = await screen.findByRole('tooltip');
    // linkMode with no divergent location means the next install symlinks.
    expect(hint.textContent).toContain('Symlinks the skill to .cursor/skills/demo');
  });
});
