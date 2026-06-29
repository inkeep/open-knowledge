import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ProjectSwitcher } from './ProjectSwitcher';

type MenuProps = {
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};
type ItemProps = {
  children?: ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
  [key: string]: unknown;
};

let lastDropdownOpenChange: ((open: boolean) => void) | null = null;
let keydownBubbleCount = 0;
let createDialogProps: Array<{ open: boolean; bridge: unknown }> = [];

mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children, onOpenChange }: MenuProps) => {
    lastDropdownOpenChange = onOpenChange ?? null;
    return <div>{children}</div>;
  },
  DropdownMenuContent: ({ children, ...props }: ItemProps) => (
    <div role="menu" {...props}>
      {children}
    </div>
  ),
  DropdownMenuItem: ({ children, disabled, onSelect, ...props }: ItemProps) => (
    <button type="button" role="menuitem" disabled={disabled} onClick={onSelect} {...props}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children, ...props }: ItemProps) => <div {...props}>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

mock.module('@/components/ui/input-group', () => ({
  InputGroup: ({ children, ...props }: ItemProps) => (
    <fieldset
      {...props}
      onKeyDown={() => {
        keydownBubbleCount += 1;
      }}
    >
      {children}
    </fieldset>
  ),
  InputGroupAddon: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  InputGroupInput: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

mock.module('@/components/ui/sidebar', () => ({
  SidebarMenuButton: ({ children, ...props }: ItemProps) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

mock.module('./CreateProjectDialog', () => ({
  CreateProjectDialog: (props: { open: boolean; bridge: unknown }) => {
    createDialogProps.push(props);
    return <div data-testid="create-project-dialog" data-open={String(props.open)} />;
  },
}));

function recent(name: string, path = `/projects/${name.toLowerCase()}`) {
  return { name, path: path.replaceAll(' ', '-') };
}

function createBridge() {
  return {
    config: {
      projectName: 'Current Project',
      projectPath: '/projects/current',
    },
    project: {
      listRecent: mock(() =>
        Promise.resolve([
          recent('Current', '/projects/current'),
          ...Array.from({ length: 10 }, (_, index) => recent(`Project ${index + 1}`)),
          recent('Omega', '/archive/omega-project'),
        ]),
      ),
      open: mock(() => Promise.resolve()),
    },
    dialog: {
      openFolder: mock(() => Promise.resolve('/chosen/folder')),
    },
    navigator: {
      open: mock(() => Promise.resolve()),
    },
  };
}

async function openMenu() {
  fireEvent.click(screen.getByTestId('project-switcher-trigger'));
  act(() => {
    lastDropdownOpenChange?.(true);
  });
  await waitFor(() => {
    expect(screen.getByTestId('project-switcher-search')).not.toBeNull();
  });
}

describe('ProjectSwitcher dropdown behavior', () => {
  beforeEach(() => {
    cleanup();
    lastDropdownOpenChange = null;
    keydownBubbleCount = 0;
    createDialogProps = [];
  });

  test('renders footer actions in order and routes each action through the expected bridge entry point', async () => {
    const bridge = createBridge();
    render(<ProjectSwitcher bridge={bridge as never} />);

    expect(screen.getByTestId('project-switcher-trigger').textContent).toContain('Current Project');

    await openMenu();

    const menuText = screen.getByTestId('project-switcher-menu').textContent ?? '';
    const newProjectIndex = menuText.indexOf('New project');
    const switchProjectIndex = menuText.indexOf('Switch project');
    const openFolderIndex = menuText.indexOf('Open folder');
    expect(newProjectIndex).toBeGreaterThan(-1);
    expect(switchProjectIndex).toBeGreaterThan(newProjectIndex);
    expect(openFolderIndex).toBeGreaterThan(switchProjectIndex);

    for (const testId of [
      'project-switcher-new-project',
      'project-switcher-switch-project',
      'project-switcher-open-folder',
    ]) {
      expect(screen.getByTestId(testId).querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    }

    fireEvent.click(screen.getByTestId('project-switcher-switch-project'));
    await waitFor(() => expect(bridge.navigator.open).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('project-switcher-open-folder'));
    await waitFor(() => {
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/chosen/folder',
        target: 'new-window',
        entryPoint: 'pick-existing',
      });
    });

    fireEvent.click(screen.getByTestId('project-switcher-recent-/projects/project-1'));
    await waitFor(() => {
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/projects/project-1',
        target: 'new-window',
        entryPoint: 'recents',
      });
    });

    fireEvent.click(screen.getByTestId('project-switcher-new-project'));
    await waitFor(() => {
      expect(screen.getByTestId('create-project-dialog').getAttribute('data-open')).toBe('true');
    });
    expect(createDialogProps.at(-1)?.bridge).toBe(bridge);
  });

  test('search filters before the ten-item slice, announces empty results, stops typeahead bubbling, and clears on close', async () => {
    const bridge = createBridge();
    render(<ProjectSwitcher bridge={bridge as never} />);

    await openMenu();

    const search = screen.getByTestId('project-switcher-search') as HTMLInputElement;

    fireEvent.keyDown(search, { key: 'O' });
    expect(keydownBubbleCount).toBe(0);

    fireEvent.change(search, { target: { value: 'omega' } });

    await waitFor(() => {
      expect(screen.getByTestId('project-switcher-recent-/archive/omega-project')).not.toBeNull();
    });
    expect(screen.queryByTestId('project-switcher-recent-/projects/project-1')).toBeNull();

    fireEvent.change(search, { target: { value: 'does-not-exist' } });

    expect((await screen.findByRole('status')).textContent).toBe('No matching projects.');

    act(() => {
      lastDropdownOpenChange?.(false);
      lastDropdownOpenChange?.(true);
    });

    await waitFor(() => {
      expect((screen.getByTestId('project-switcher-search') as HTMLInputElement).value).toBe('');
    });
  });
});
