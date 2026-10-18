import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

const putSkillFolderAction = vi.fn(async (_body: unknown) => ({ ok: true as const }));

vi.mock('@/hooks/use-skills', () => ({
  useSkills: () => ({
    status: 'ready',
    data: [
      {
        scope: 'project',
        name: 'other',
        hosts: [],
        path: '.team/skills/other/SKILL.md',
        customPlacements: [{ path: '.team/skills/other', mode: 'copy' }],
      },
    ],
  }),
}));

vi.mock('@/lib/skills-api', () => ({
  placeSkill: vi.fn(),
  putSkillFolderAction,
  setSkillSource: vi.fn(),
  unplaceSkill: vi.fn(),
}));

const { SkillInstallMenuItems } = await import('./SkillInstallMenu');
const {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} = await import('@/components/ui/dropdown-menu');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { useState } = await import('react');

const toggles = {
  hostSet: new Set(['claude', 'codex', 'cursor']),
  installed: true,
  installing: false,
  toggleEditor: vi.fn(),
  installAll: vi.fn(),
  linkMode: true,
  setSource: vi.fn(),
  placeAt: vi.fn(),
  unplaceAt: vi.fn(),
  convertLocation: vi.fn(),
  convertLocations: vi.fn(),
  sourceHost: 'claude',
};

const skill = {
  scope: 'project',
  name: 'demo',
  hosts: ['claude', 'codex', 'cursor'],
  symlinkedHosts: ['codex'],
  path: '.claude/skills/demo/SKILL.md',
  hostAliases: { pi: '.opencode/skills', copilot: '.team/skills' },
};

const onRunStart = vi.fn();
const menuOpenChange = vi.fn((_open: boolean) => {});
const submenuOpenChange = vi.fn((_open: boolean) => {});

type MenuHostKind = 'menu' | 'submenu';

function MenuHost({ kind }: { kind: MenuHostKind }) {
  const [open, setOpen] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  const items = (
    <SkillInstallMenuItems
      toggles={toggles as never}
      skill={skill as never}
      onRunStart={onRunStart}
    />
  );
  return (
    <TooltipProvider>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          menuOpenChange(next);
          setOpen(next);
        }}
      >
        <DropdownMenuTrigger>Skill menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          {kind === 'menu' ? (
            items
          ) : (
            <DropdownMenuSub
              open={subOpen}
              onOpenChange={(next) => {
                submenuOpenChange(next);
                setSubOpen(next);
              }}
            >
              <DropdownMenuSubTrigger>Install</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>{items}</DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
}

async function renderMenu(kind: MenuHostKind = 'menu') {
  render(<MenuHost kind={kind} />);
  await userEvent.click(screen.getByRole('button', { name: 'Skill menu' }));
  if (kind === 'submenu') {
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Install' }));
  }
  await screen.findByTestId('skill-install-all');
  menuOpenChange.mockClear();
  submenuOpenChange.mockClear();
}

function expectMenuStayedOpen() {
  expect(menuOpenChange).not.toHaveBeenCalledWith(false);
  expect(submenuOpenChange).not.toHaveBeenCalledWith(false);
  expect(screen.getByTestId('skill-install-all')).toBeTruthy();
}

const HOSTS: readonly MenuHostKind[] = ['menu', 'submenu'];

function confirmDialog(): HTMLElement {
  return screen.getByRole('alertdialog');
}

const PATHS = [
  {
    name: 'installing into a folder other agents read',
    trigger: 'skill-install-editor-opencode',
    title: 'Install in a shared folder?',
    description: 'Adds the skill to .opencode/skills — also read by Pi',
    confirmLabel: 'Install',
    acted: () => toggles.toggleEditor,
    expected: ['opencode', true],
  },
  {
    name: 'placing into a shared custom root',
    trigger: 'skill-custom-root-.team/skills',
    title: 'Install in a shared folder?',
    description: 'Adds the skill to .team/skills — also read by GitHub Copilot',
    confirmLabel: 'Install',
    acted: () => toggles.placeAt,
    expected: ['.team/skills', 'link'],
  },
  {
    name: 'stopping an agent reading the skill',
    trigger: 'skill-audience-unfollow-pi',
    title: 'Stop Pi reading this skill',
    description: 'Stop Pi reading "demo"? .pi/skills will keep its other skills',
    confirmLabel: 'Stop reading',
    acted: () => putSkillFolderAction,
    expected: [{ scope: 'project', root: '.pi/skills', action: 'unlink', exclude: ['demo'] }],
  },
  {
    name: 'converting one location',
    trigger: 'skill-convert-cursor',
    title: 'Replace with a symlink?',
    description: 'Replace the copy at .cursor/skills/demo with a symlink',
    confirmLabel: 'Replace with symlink',
    acted: () => toggles.convertLocation,
    expected: ['cursor', 'link'],
  },
  {
    name: 'converting every location',
    trigger: 'skill-convert-all',
    title: 'Replace these symlinks with independent copies?',
    description: 'A copy is a real folder of its own',
    confirmLabel: 'Convert locations to copies',
    acted: () => toggles.convertLocations,
    expected: [[{ target: 'codex', mode: 'copy' }]],
  },
] as const;

describe('install menu confirmations', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const CASES = HOSTS.flatMap((host) => PATHS.map((path) => ({ host, ...path })));

  test.each(CASES)(
    'in a $host, $name asks in an in-app dialog, keeps the menu open, and acts only once confirmed',
    async ({ host, trigger, title, description, confirmLabel, acted, expected }) => {
      await renderMenu(host);
      await userEvent.click(screen.getByTestId(trigger));

      const dialog = confirmDialog();
      expect(within(dialog).getByRole('heading', { name: title })).toBeTruthy();
      expect(dialog.textContent).toContain(description);
      expect(acted()).not.toHaveBeenCalled();
      expectMenuStayedOpen();

      await userEvent.click(within(dialog).getByRole('button', { name: confirmLabel }));

      expect(acted()).toHaveBeenCalledTimes(1);
      expect(acted()).toHaveBeenCalledWith(...expected);
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expectMenuStayedOpen();
    },
  );

  test.each(CASES)(
    'in a $host, cancelling $name closes the dialog, keeps the menu open, returns focus to the control that asked, and changes nothing',
    async ({ host, trigger, acted }) => {
      await renderMenu(host);
      const opener = screen.getByTestId(trigger);
      await userEvent.click(opener);

      await userEvent.click(within(confirmDialog()).getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(acted()).not.toHaveBeenCalled();
      expect(onRunStart).not.toHaveBeenCalled();
      expectMenuStayedOpen();
      await waitFor(() => expect(document.activeElement).toBe(opener));
    },
  );

  test('converting every location lists the paths it will replace and says the source stays', async () => {
    await renderMenu();
    await userEvent.click(screen.getByTestId('skill-convert-all'));

    const dialog = confirmDialog();
    expect(within(dialog).getByTestId('skill-install-confirm-paths').textContent).toBe(
      '.codex/skills/demo',
    );
    expect(dialog.textContent).toContain('The source folder itself does not move.');
  });

  test('a conversion confirmed in the dialog starts the run before converting', async () => {
    await renderMenu();
    await userEvent.click(screen.getByTestId('skill-convert-cursor'));
    await userEvent.click(
      within(confirmDialog()).getByRole('button', { name: 'Replace with symlink' }),
    );

    expect(onRunStart).toHaveBeenCalledTimes(1);
    expect(onRunStart.mock.invocationCallOrder[0]).toBeLessThan(
      toggles.convertLocation.mock.invocationCallOrder[0] ?? 0,
    );
  });

  test('removing a location needs no confirmation', async () => {
    await renderMenu();
    await userEvent.click(screen.getByTestId('skill-install-editor-codex'));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(toggles.toggleEditor).toHaveBeenCalledWith('codex', false);
  });
});
