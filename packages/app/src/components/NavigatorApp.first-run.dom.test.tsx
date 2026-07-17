import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

let createDialogProps: Array<{
  open: boolean;
  initialPackId?: string;
  packs?: Array<{ id: string }>;
  onOpenChange?: (next: boolean) => void;
}> = [];
let listPacksImpl: () => Promise<unknown> = () =>
  Promise.resolve({
    ok: true,
    packs: [
      {
        id: 'knowledge-base',
        name: 'Knowledge base',
        description: '',
        folders: [],
        entryCounts: { files: 0, folders: 0 },
      },
    ],
  });

mock.module('next-themes', () => ({
  useTheme: () => ({ theme: undefined }),
}));

mock.module('@/hooks/use-theme-bridge', () => ({
  useThemeBridge: () => {},
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

// Stub the pack grid: expose a single card whose click fires onPackSelect so
// the launcher's pack → dialog wiring can be asserted without the real grid.
// The card only renders once `packs` has loaded (mirrors the real grid, which
// shows skeletons while null) — so `findByTestId(card)` waits for the launcher's
// listPacks fetch to settle before a click, and the resolved pack name is
// available by then (avoids racing the async fetch under full-suite timing).
mock.module('./PackCardGrid', () => ({
  PackCardGrid: ({
    onPackSelect,
    packs,
  }: {
    onPackSelect: (id: string) => void;
    packs?: unknown[] | null;
  }) =>
    packs == null ? (
      <div data-testid="pack-grid-loading" />
    ) : (
      <button
        type="button"
        data-testid="pack-card-knowledge-base"
        onClick={() => onPackSelect('knowledge-base')}
      >
        Knowledge base
      </button>
    ),
}));

mock.module('@/lib/seed-client', () => ({
  seedClient: () => ({ listPacks: () => listPacksImpl() }),
}));

mock.module('./CreateProjectDialog', () => ({
  CreateProjectDialog: (props: {
    open: boolean;
    initialPackId?: string;
    packs?: Array<{ id: string }>;
    onOpenChange?: (next: boolean) => void;
  }) => {
    createDialogProps.push(props);
    return (
      <div
        data-testid="create-project-dialog"
        data-open={String(props.open)}
        data-pack-id={props.initialPackId ?? ''}
        data-pack-count={props.packs === undefined ? '' : String(props.packs.length)}
      >
        {/* Stand-in for the dialog's own close path (Escape / backdrop /
            Cancel) so a test can drive the parent's onOpenChange(false)
            without the real Radix dialog. */}
        <button
          type="button"
          data-testid="create-dialog-close"
          onClick={() => props.onOpenChange?.(false)}
        />
      </div>
    );
  },
}));

mock.module('./CloneDialog', () => ({
  CloneDialog: (props: { open: boolean }) => (
    <div data-testid="clone-dialog" data-open={String(props.open)} />
  ),
}));

mock.module('./AuthModal', () => ({ AuthModal: () => null }));
mock.module('./ConsentDialog', () => ({ ConsentDialog: () => null }));
mock.module('./McpConsentDialog', () => ({ McpConsentDialog: () => null }));
mock.module('./ShareReceiveDialog', () => ({ ShareReceiveDialog: () => null }));
mock.module('@/lib/share/clone-controller', () => ({ createCloneController: () => ({}) }));
mock.module('@/lib/transports/auth-query-transport', () => ({ ipcAuthQueryTransport: () => ({}) }));
mock.module('@/lib/transports/auth-transport', () => ({ ipcAuthTransport: () => ({}) }));
mock.module('@/lib/transports/clone-transport', () => ({ ipcCloneTransport: () => ({}) }));

function createBridge(recents: unknown[]) {
  return {
    appVersion: '0.4.0-beta.1',
    onMenuAction: mock(() => () => {}),
    config: { mode: 'navigator' },
    project: {
      listRecent: mock(() => Promise.resolve(recents)),
      removeRecent: mock(() => Promise.resolve()),
      open: mock(() => Promise.resolve()),
      createNew: mock(() => Promise.resolve()),
      recordCreateNewBannerShown: mock(() => Promise.resolve()),
      readHeadBranch: mock(() => Promise.resolve({ currentBranch: null })),
    },
    dialog: {
      openFolder: mock(() => Promise.resolve('/picked/folder')),
    },
  };
}

async function renderNavigator(bridge: ReturnType<typeof createBridge>) {
  Object.defineProperty(window, 'okDesktop', { configurable: true, value: bridge });
  render(<NavigatorApp bridge={bridge as never} />);
  await waitFor(() => expect(bridge.project.listRecent).toHaveBeenCalledTimes(1));
}

// Import the component AFTER the mocks above register so its transitive
// dependencies bind to the stubs rather than the real modules.
const { NavigatorApp } = await import('./NavigatorApp');

describe('NavigatorApp first-run packs-forward launcher', () => {
  beforeEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'okDesktop');
    createDialogProps = [];
    listPacksImpl = () =>
      Promise.resolve({
        ok: true,
        packs: [
          {
            id: 'knowledge-base',
            name: 'Knowledge base',
            description: '',
            folders: [],
            entryCounts: { files: 0, folders: 0 },
          },
        ],
      });
  });

  afterEach(() => cleanup());

  test('leads with the pack grid + demoted secondary row when there are no recents', async () => {
    const bridge = createBridge([]);
    await renderNavigator(bridge);

    // Packs-forward view present; three-card launcher absent.
    const firstRun = await screen.findByTestId('nav-first-run');
    expect(firstRun.textContent).toContain('What do you want to build?');
    expect(screen.queryByTestId('nav-create-new')).toBeNull();

    // Secondary row keeps all three original doors.
    expect(screen.getByTestId('nav-first-run-open')).not.toBeNull();
    expect(screen.getByTestId('nav-first-run-clone')).not.toBeNull();
    expect(screen.getByTestId('nav-first-run-blank')).not.toBeNull();
  });

  test('pack click opens the create dialog with the pack pre-selected + the pack list', async () => {
    const bridge = createBridge([]);
    await renderNavigator(bridge);

    const card = await screen.findByTestId('pack-card-knowledge-base');
    fireEvent.click(card);

    await waitFor(() => {
      const dialog = screen.getByTestId('create-project-dialog');
      expect(dialog.getAttribute('data-open')).toBe('true');
      expect(dialog.getAttribute('data-pack-id')).toBe('knowledge-base');
      // The full pack list (not a name string) threads through so the dialog
      // can look up the chosen pack's display metadata — the stub listPacks
      // returns one pack.
      expect(dialog.getAttribute('data-pack-count')).toBe('1');
    });
  });

  test('secondary Blank project opens the create dialog with no pack selected', async () => {
    const bridge = createBridge([]);
    await renderNavigator(bridge);

    fireEvent.click(await screen.findByTestId('nav-first-run-blank'));
    await waitFor(() => {
      const dialog = screen.getByTestId('create-project-dialog');
      expect(dialog.getAttribute('data-open')).toBe('true');
      expect(dialog.getAttribute('data-pack-id')).toBe('');
    });
  });

  test('secondary Open folder routes through the pick-existing entry point', async () => {
    const bridge = createBridge([]);
    await renderNavigator(bridge);

    fireEvent.click(await screen.findByTestId('nav-first-run-open'));
    await waitFor(() => {
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/picked/folder',
        target: 'new-window',
        entryPoint: 'pick-existing',
      });
    });
  });

  test('pack selection clears on dialog close — reopening Blank carries no stale pack', async () => {
    const bridge = createBridge([]);
    await renderNavigator(bridge);

    // Open via a pack card → dialog carries the pre-selected pack.
    fireEvent.click(await screen.findByTestId('pack-card-knowledge-base'));
    await waitFor(() => {
      const dialog = screen.getByTestId('create-project-dialog');
      expect(dialog.getAttribute('data-open')).toBe('true');
      expect(dialog.getAttribute('data-pack-id')).toBe('knowledge-base');
    });

    // Close the dialog (Escape / backdrop / Cancel stand-in).
    fireEvent.click(screen.getByTestId('create-dialog-close'));
    await waitFor(() => {
      expect(screen.getByTestId('create-project-dialog').getAttribute('data-open')).toBe('false');
    });

    // Reopen via the secondary "Blank project" door — the stale packId must
    // not leak in, or the blank-create path would silently seed a pack.
    fireEvent.click(screen.getByTestId('nav-first-run-blank'));
    await waitFor(() => {
      const dialog = screen.getByTestId('create-project-dialog');
      expect(dialog.getAttribute('data-open')).toBe('true');
      expect(dialog.getAttribute('data-pack-id')).toBe('');
    });
  });

  test('listPacks error still renders a usable first-run state (secondary row intact)', async () => {
    listPacksImpl = () =>
      Promise.resolve({ ok: false, error: { kind: 'internal', message: 'boom' } });
    const bridge = createBridge([]);
    await renderNavigator(bridge);

    // The packs-forward view still mounts; the demoted secondary row remains
    // the user's path forward even when the pack fetch fails.
    const firstRun = await screen.findByTestId('nav-first-run');
    expect(firstRun).not.toBeNull();
    expect(screen.getByTestId('nav-first-run-secondary')).not.toBeNull();
    expect(screen.getByTestId('nav-first-run-open')).not.toBeNull();
    expect(screen.getByTestId('nav-first-run-clone')).not.toBeNull();
    expect(screen.getByTestId('nav-first-run-blank')).not.toBeNull();
  });

  test('renders the returning-user three-card launcher unchanged when recents exist', async () => {
    const bridge = createBridge([{ path: '/projects/recent', name: 'Recent Project' }]);
    await renderNavigator(bridge);

    // Three-card launcher present; packs-forward view absent.
    expect(await screen.findByTestId('nav-create-new')).not.toBeNull();
    expect(screen.getByTestId('nav-open')).not.toBeNull();
    expect(screen.getByTestId('nav-clone')).not.toBeNull();
    expect(screen.queryByTestId('nav-first-run')).toBeNull();
    expect(await screen.findByTestId('nav-recent-list')).not.toBeNull();
  });

  test('listRecent failure falls back to the three-card launcher, not the packs view', async () => {
    // A rejected listRecent leaves `recents` empty — but an empty-because-failed
    // fetch must NOT read as "brand-new user" and show the first-run packs
    // onboarding. It falls back to the returning-user three-card launcher.
    const bridge = createBridge([]);
    bridge.project.listRecent = mock(() => Promise.reject(new Error('boom')));
    await renderNavigator(bridge);

    expect(await screen.findByTestId('nav-create-new')).not.toBeNull();
    expect(screen.getByTestId('nav-open')).not.toBeNull();
    expect(screen.getByTestId('nav-clone')).not.toBeNull();
    // The first-run packs view must be absent.
    expect(screen.queryByTestId('nav-first-run')).toBeNull();
    // The failure surfaces the error banner.
    expect(screen.getByTestId('nav-error-banner')).not.toBeNull();
  });
});
