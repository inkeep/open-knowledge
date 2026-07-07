import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';
import { NavigatorApp } from './NavigatorApp';

let themeBridgeCalls: Array<[unknown, string]> = [];
let createDialogProps: Array<{ open: boolean; bridge: unknown }> = [];
let cloneDialogProps: Array<{
  open: boolean;
  onCloneComplete: (payload: { dir: string }) => void;
}> = [];

mock.module('next-themes', () => ({
  useTheme: () => ({ theme: undefined }),
}));

mock.module('@/hooks/use-theme-bridge', () => ({
  useThemeBridge: (bridge: unknown, theme: string) => {
    themeBridgeCalls.push([bridge, theme]);
  },
}));

mock.module('./BetaBadge', () => ({
  BetaBadge: () => <span data-testid="beta-badge">Beta</span>,
}));

mock.module('./ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

mock.module('./ui/badge', () => ({
  Badge: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <span {...props}>{children}</span>
  ),
}));

mock.module('./CreateProjectDialog', () => ({
  CreateProjectDialog: (props: { open: boolean; bridge: unknown }) => {
    createDialogProps.push(props);
    return <div data-testid="create-project-dialog" data-open={String(props.open)} />;
  },
}));

mock.module('./CloneDialog', () => ({
  CloneDialog: (props: { open: boolean; onCloneComplete: (payload: { dir: string }) => void }) => {
    cloneDialogProps.push(props);
    return <div data-testid="clone-dialog" data-open={String(props.open)} />;
  },
}));

mock.module('./AuthModal', () => ({
  AuthModal: () => null,
}));

mock.module('./ConsentDialog', () => ({
  ConsentDialog: () => null,
}));

mock.module('./McpConsentDialog', () => ({
  McpConsentDialog: () => null,
}));

mock.module('./ShareReceiveDialog', () => ({
  ShareReceiveDialog: () => null,
}));

mock.module('@/lib/share/clone-controller', () => ({
  createCloneController: () => ({}),
}));

mock.module('@/lib/transports/auth-query-transport', () => ({
  ipcAuthQueryTransport: () => ({}),
}));

mock.module('@/lib/transports/auth-transport', () => ({
  ipcAuthTransport: () => ({}),
}));

mock.module('@/lib/transports/clone-transport', () => ({
  ipcCloneTransport: () => ({}),
}));

function createBridge() {
  return {
    appVersion: '0.4.0-beta.1',
    onMenuAction: mock(() => () => {}),
    config: {
      collabUrl: '',
      apiOrigin: '',
      projectPath: '',
      projectName: 'Project Navigator',
      mode: 'navigator',
    },
    project: {
      listRecent: mock(() =>
        Promise.resolve([{ path: '/projects/recent', name: 'Recent Project' }]),
      ),
      removeRecent: mock(() => Promise.resolve()),
      getSessionState: mock(() => Promise.resolve({})),
      setSessionState: mock(() => Promise.resolve()),
      open: mock(() => Promise.resolve()),
      createNew: mock(() => Promise.resolve()),
      recordCreateNewBannerShown: mock(() => Promise.resolve()),
      close: mock(() => Promise.resolve()),
    },
    dialog: {
      openFolder: mock(() => Promise.resolve('/picked/folder')),
    },
  };
}

async function renderNavigator(bridge: ReturnType<typeof createBridge>) {
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    value: bridge,
  });
  render(<NavigatorApp bridge={bridge as never} />);
  await waitFor(() => expect(bridge.project.listRecent).toHaveBeenCalledTimes(1));
}

describe('NavigatorApp launcher runtime behavior', () => {
  beforeEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'okDesktop');
    themeBridgeCalls = [];
    createDialogProps = [];
    cloneDialogProps = [];
  });

  afterEach(() => {
    cleanup();
  });

  test('renders the launcher chrome, beta badge, drag strip, and theme bridge fallback', async () => {
    const bridge = createBridge();
    await renderNavigator(bridge);

    expect(screen.getByRole('heading', { name: 'OpenKnowledge' })).not.toBeNull();
    expect(screen.getByTestId('beta-badge').textContent).toBe('Beta');
    expect(document.body.textContent).not.toContain('Stable');

    expect(themeBridgeCalls.at(-1)).toEqual([bridge, 'system']);

    const chromeRow = screen.getByTestId('nav-chrome-row');
    expect(chromeRow.getAttribute('data-electron-drag')).toBe('');
    expectVisualClassTokens(chromeRow.className, ['inset-x-0', 'h-9']);
    expect(screen.getByTestId('nav-open').getAttribute('data-electron-no-drag')).toBeNull();
    expect(screen.getByTestId('nav-create-new').getAttribute('data-electron-no-drag')).toBeNull();
    await screen.findByTestId('nav-recent-list');
    expect(document.querySelector('[data-electron-no-drag]')).toBeNull();
  });

  test('routes open, recent, create, and clone-complete actions through the expected entry points', async () => {
    const bridge = createBridge();
    await renderNavigator(bridge);

    fireEvent.click(screen.getByTestId('nav-open'));
    await waitFor(() => {
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/picked/folder',
        target: 'new-window',
        entryPoint: 'pick-existing',
      });
    });

    fireEvent.click(await screen.findByText('Recent Project'));
    await waitFor(() => {
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/projects/recent',
        target: 'new-window',
        entryPoint: 'recents',
      });
    });

    fireEvent.click(screen.getByTestId('nav-create-new'));
    await waitFor(() => {
      expect(screen.getByTestId('create-project-dialog').getAttribute('data-open')).toBe('true');
    });
    expect(createDialogProps.at(-1)?.bridge).toBe(bridge);

    fireEvent.click(screen.getByTestId('nav-clone'));
    await waitFor(() => {
      expect(screen.getByTestId('clone-dialog').getAttribute('data-open')).toBe('true');
    });

    act(() => {
      cloneDialogProps.at(-1)?.onCloneComplete({ dir: '/cloned/project' });
    });

    await waitFor(() => {
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/cloned/project',
        target: 'new-window',
        entryPoint: 'pick-existing',
      });
    });
  });

  test('labels a linked-worktree recent with its branch over its base project, leaving plain projects unchanged', async () => {
    const bridge = createBridge();
    bridge.project.listRecent = mock(() =>
      Promise.resolve([
        {
          path: '/Users/x/pnw-fishing/.ok/worktrees/dev',
          name: 'dev',
          isLinkedWorktree: true,
          mainRoot: '/Users/x/pnw-fishing',
          branch: 'dev',
        },
        { path: '/Users/x/plain-notes', name: 'Plain Notes' },
      ]),
    );
    await renderNavigator(bridge);

    const list = await screen.findByTestId('nav-recent-list');
    // Worktree row: name up top, a "worktree" badge, and an "of <parent>" subline.
    expect(list.textContent).toContain('dev');
    expect(list.textContent).toContain('pnw-fishing');
    // Plain project row keeps its name + full path, unlabeled.
    expect(list.textContent).toContain('Plain Notes');
    expect(list.textContent).toContain('/Users/x/plain-notes');
  });

  test('flags worktrees with a badge + branch chip; projects show their path', async () => {
    const bridge = createBridge();
    bridge.project.listRecent = mock(() =>
      Promise.resolve([
        {
          path: '/Users/x/pnw-fishing/.ok/worktrees/dev',
          name: 'dev',
          isLinkedWorktree: true,
          mainRoot: '/Users/x/pnw-fishing',
          branch: 'dev',
        },
        { path: '/Users/x/plain-notes', name: 'Plain Notes' },
      ]),
    );
    await renderNavigator(bridge);

    const list = await screen.findByTestId('nav-recent-list');
    const rows = list.querySelectorAll('li');
    expect(rows.length).toBe(2);

    const [worktreeRow, plainRow] = rows;
    if (!worktreeRow || !plainRow) throw new Error('expected two recent rows');

    // every row leads with the same folder icon; a worktree
    // is flagged by a "worktree" pill + an "of <parent>" subline, and every row
    // gets a right-aligned branch chip.
    expect(worktreeRow.querySelector('svg.lucide-folder')).not.toBeNull();
    expect(worktreeRow.textContent).toContain('dev');
    expect(worktreeRow.textContent).toContain('worktree');
    expect(worktreeRow.textContent).toContain('of pnw-fishing');
    expect(
      worktreeRow.querySelector(
        '[data-testid="nav-recent-branch-/Users/x/pnw-fishing/.ok/worktrees/dev"]',
      ),
    ).not.toBeNull();

    // Plain project: same folder icon, its full path, and NO worktree pill. (Its
    // branch chip comes from async git detection — exercised in real use, not here.)
    expect(plainRow.querySelector('svg.lucide-folder')).not.toBeNull();
    expect(plainRow.textContent).toContain('Plain Notes');
    expect(plainRow.textContent).toContain('/Users/x/plain-notes');
    expect(plainRow.textContent).not.toContain('worktree');
  });
});
