import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

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
    expect(screen.getByTestId('skill-install-editor-codex')).toHaveProperty('ariaChecked', 'true');
    expect(screen.getByTestId('skill-install-editor-cursor')).toHaveProperty(
      'ariaChecked',
      'false',
    );

    await userEvent.click(screen.getByTestId('skill-install-editor-cursor'));
    expect(toggles.toggleEditor).toHaveBeenCalledWith('cursor', true);
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
    expect(screen.queryByTestId('skill-convert-codex')).toBeNull();
    expect(screen.getByTestId('skill-set-source-codex').textContent).toBe('make source');
  });

  test('an installed row says clicking it removes the skill, via a tooltip', async () => {
    renderMenu();
    const row = screen.getByTestId('skill-install-editor-codex');
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
    expect(hint.textContent).toContain('Symlinks the skill to .cursor/skills/demo');
  });
});
