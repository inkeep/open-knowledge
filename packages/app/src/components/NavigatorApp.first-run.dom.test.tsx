import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';

let createDialogProps: Array<{
  open: boolean;
  initialPackId?: string;
  packs?: Array<{ id: string }>;
  onOpenChange?: (next: boolean) => void;
}> = [];
const PACK_IDS = [
  'knowledge-base',
  'software-lifecycle',
  'codebase-wiki',
  'plain-notes',
  'worldbuilding',
] as const;

function packFixture() {
  return PACK_IDS.map((id) => ({
    id,
    name: id,
    description: `Description for ${id}`,
    folders: [],
    entryCounts: { files: 0, folders: 0 },
  }));
}

const okPacks = () => Promise.resolve({ ok: true, packs: packFixture() });

let listPacksImpl: () => Promise<unknown> = okPacks;

vi.doMock('next-themes', () => ({
  useTheme: () => ({ theme: undefined }),
}));

vi.doMock('@/hooks/use-theme-bridge', () => ({
  useThemeBridge: () => {},
}));

vi.doMock('./BetaBadge', () => ({
  BetaBadge: () => <span data-testid="beta-badge">Beta</span>,
}));

vi.doMock('./ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.doMock('./ui/badge', () => ({
  Badge: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <span {...props}>{children}</span>
  ),
}));

vi.doMock('./PackCardGrid', () => ({
  iconForPack: () => () => null,
  PackCardGrid: ({
    onPackSelect,
    packs,
  }: {
    onPackSelect: (id: string) => void;
    packs?: Array<{ id: string }> | null;
  }) =>
    packs == null ? (
      <div data-testid="pack-grid-loading" />
    ) : (
      <div>
        {packs.map((pack) => (
          <button
            key={pack.id}
            type="button"
            data-testid={`pack-card-${pack.id}`}
            onClick={() => onPackSelect(pack.id)}
          >
            {pack.id}
          </button>
        ))}
      </div>
    ),
}));

vi.doMock('@/lib/seed-client', () => ({
  seedClient: () => ({ listPacks: () => listPacksImpl() }),
}));

vi.doMock('./CreateProjectDialog', () => ({
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
        {}
        <button
          type="button"
          data-testid="create-dialog-close"
          onClick={() => props.onOpenChange?.(false)}
        />
      </div>
    );
  },
}));

vi.doMock('./CloneDialog', () => ({
  CloneDialog: (props: { open: boolean }) => (
    <div data-testid="clone-dialog" data-open={String(props.open)} />
  ),
}));

vi.doMock('./AuthModal', () => ({ AuthModal: () => null }));
vi.doMock('./ConsentDialog', () => ({ ConsentDialog: () => null }));
vi.doMock('./McpConsentDialog', () => ({ McpConsentDialog: () => null }));
vi.doMock('./ShareReceiveDialog', () => ({ ShareReceiveDialog: () => null }));
vi.doMock('@/lib/share/clone-controller', () => ({ createCloneController: () => ({}) }));
vi.doMock('@/lib/transports/auth-query-transport', () => ({ ipcAuthQueryTransport: () => ({}) }));
vi.doMock('@/lib/transports/auth-transport', () => ({ ipcAuthTransport: () => ({}) }));
vi.doMock('@/lib/transports/clone-transport', () => ({ ipcCloneTransport: () => ({}) }));

function createBridge(recents: unknown[]) {
  return {
    appVersion: '0.4.0-beta.1',
    onMenuAction: vi.fn(() => () => {}),
    onRecentRemovedMissing: vi.fn(() => () => {}),
    config: { mode: 'navigator' },
    integrations: {
      status: async () => ({
        available: false,
        editors: [],
        path: { shellDetected: false, rcFilesToTouch: [], installed: false },
        skills: [],
        detectedEditorIds: [],
      }),
    },
    project: {
      listRecent: vi.fn(() => Promise.resolve(recents)),
      removeRecent: vi.fn(() => Promise.resolve()),
      open: vi.fn(() => Promise.resolve()),
      createNew: vi.fn(() => Promise.resolve()),
      recordCreateNewBannerShown: vi.fn(() => Promise.resolve()),
      readHeadBranch: vi.fn(() => Promise.resolve({ currentBranch: null })),
    },
    dialog: {
      openFolder: vi.fn(() => Promise.resolve('/picked/folder')),
    },
  };
}

async function renderNavigator(bridge: ReturnType<typeof createBridge>) {
  Object.defineProperty(window, 'okDesktop', { configurable: true, value: bridge });
  render(
    <TooltipProvider>
      <NavigatorApp bridge={bridge as never} />
    </TooltipProvider>,
  );
  await waitFor(() => expect(bridge.project.listRecent).toHaveBeenCalledTimes(1));
}

const { NavigatorApp } = await import('./NavigatorApp');

describe('NavigatorApp launcher — starter-pack line', () => {
  beforeEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'okDesktop');
    createDialogProps = [];
    listPacksImpl = okPacks;
  });

  afterEach(() => cleanup());

  test('shows the four launcher cards plus the starter-pack line when there are no recents', async () => {
    const bridge = createBridge([]);
    await renderNavigator(bridge);

    expect(await screen.findByTestId('nav-create-new')).not.toBeNull();
    expect(screen.getByTestId('nav-open')).not.toBeNull();
    expect(screen.getByTestId('nav-open-file')).not.toBeNull();
    expect(screen.getByTestId('nav-clone')).not.toBeNull();

    const row = await screen.findByTestId('nav-starter-packs');
    expect(row.textContent).toContain('or use a starter pack');
    expect(screen.getByTestId('nav-pack-pill-knowledge-base')).not.toBeNull();
    expect(screen.getByTestId('nav-pack-pill-software-lifecycle')).not.toBeNull();
    expect(screen.getByTestId('nav-pack-pill-codebase-wiki')).not.toBeNull();
    expect(screen.queryByTestId('nav-pack-pill-plain-notes')).toBeNull();
    expect(screen.getByTestId('nav-pack-more').textContent).toContain('2');
  });

  test('the overflow count carries an accessible name naming the total', async () => {
    const bridge = createBridge([]);
    await renderNavigator(bridge);

    const more = await screen.findByTestId('nav-pack-more');
    expect(more.getAttribute('aria-label')).toBe('See all 5 starter packs');
  });

  test('hovering a pack pill surfaces its description in a tooltip', async () => {
    const bridge = createBridge([]);
    await renderNavigator(bridge);

    await userEvent.hover(await screen.findByTestId('nav-pack-pill-knowledge-base'));

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Description for knowledge-base');
  });

  test('no overflow affordance when every pack fits in the pill row', async () => {
    listPacksImpl = () =>
      Promise.resolve({
        ok: true,
        packs: packFixture().slice(0, 3),
      });
    const bridge = createBridge([]);
    await renderNavigator(bridge);

    await screen.findByTestId('nav-pack-pill-codebase-wiki');
    expect(screen.queryByTestId('nav-pack-more')).toBeNull();
  });

  test('pill click opens the create dialog with the pack pre-selected + the pack list', async () => {
    const bridge = createBridge([]);
    await renderNavigator(bridge);

    fireEvent.click(await screen.findByTestId('nav-pack-pill-knowledge-base'));

    await waitFor(() => {
      const dialog = screen.getByTestId('create-project-dialog');
      expect(dialog.getAttribute('data-open')).toBe('true');
      expect(dialog.getAttribute('data-pack-id')).toBe('knowledge-base');
      expect(dialog.getAttribute('data-pack-count')).toBe('5');
    });
  });

  test('the overflow count opens the create dialog on its own pack grid', async () => {
    const bridge = createBridge([]);
    await renderNavigator(bridge);

    fireEvent.click(await screen.findByTestId('nav-pack-more'));

    await waitFor(() => {
      const dialog = screen.getByTestId('create-project-dialog');
      expect(dialog.getAttribute('data-open')).toBe('true');
      expect(dialog.getAttribute('data-pack-id')).toBe('');
      expect(dialog.getAttribute('data-pack-count')).toBe('5');
    });
    expect(screen.queryByTestId('nav-pack-picker')).toBeNull();
  });

  test('Create new project opens the create dialog with no pack selected', async () => {
    const bridge = createBridge([]);
    await renderNavigator(bridge);

    fireEvent.click(await screen.findByTestId('nav-create-new'));
    await waitFor(() => {
      const dialog = screen.getByTestId('create-project-dialog');
      expect(dialog.getAttribute('data-open')).toBe('true');
      expect(dialog.getAttribute('data-pack-id')).toBe('');
    });
  });

  test('Open folder on disk routes through the pick-existing entry point', async () => {
    const bridge = createBridge([]);
    await renderNavigator(bridge);

    fireEvent.click(await screen.findByTestId('nav-open'));
    await waitFor(() => {
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/picked/folder',
        target: 'new-window',
        entryPoint: 'pick-existing',
      });
    });
  });

  test('pack selection clears on dialog close — reopening Create carries no stale pack', async () => {
    const bridge = createBridge([]);
    await renderNavigator(bridge);

    fireEvent.click(await screen.findByTestId('nav-pack-pill-knowledge-base'));
    await waitFor(() => {
      const dialog = screen.getByTestId('create-project-dialog');
      expect(dialog.getAttribute('data-open')).toBe('true');
      expect(dialog.getAttribute('data-pack-id')).toBe('knowledge-base');
    });

    fireEvent.click(screen.getByTestId('create-dialog-close'));
    await waitFor(() => {
      expect(screen.getByTestId('create-project-dialog').getAttribute('data-open')).toBe('false');
    });

    fireEvent.click(screen.getByTestId('nav-create-new'));
    await waitFor(() => {
      const dialog = screen.getByTestId('create-project-dialog');
      expect(dialog.getAttribute('data-open')).toBe('true');
      expect(dialog.getAttribute('data-pack-id')).toBe('');
    });
  });

  test('listPacks failure drops the pack line entirely, leaving the four cards', async () => {
    let settle: (result: unknown) => void = () => {};
    const listPacks = vi.fn(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    listPacksImpl = listPacks;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bridge = createBridge([]);
    await renderNavigator(bridge);

    await waitFor(() => expect(listPacks).toHaveBeenCalled());
    expect(screen.queryByTestId('nav-starter-packs')).toBeNull();

    settle({ ok: false, error: { kind: 'internal', message: 'boom' } });
    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        '[NavigatorApp] listPacks returned error:',
        expect.anything(),
      ),
    );

    expect(await screen.findByTestId('nav-create-new')).not.toBeNull();
    expect(screen.queryByTestId('nav-starter-packs')).toBeNull();
    expect(screen.queryByTestId('nav-pack-more')).toBeNull();
    errorSpy.mockRestore();
  });

  test('a thrown listPacks drops the pack line too, leaving the four cards', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    listPacksImpl = () => Promise.reject(new Error('network down'));
    const bridge = createBridge([]);
    await renderNavigator(bridge);

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[NavigatorApp] listPacks failed:', expect.any(Error)),
    );

    expect(await screen.findByTestId('nav-create-new')).not.toBeNull();
    expect(screen.queryByTestId('nav-starter-packs')).toBeNull();
    expect(screen.queryByTestId('nav-pack-more')).toBeNull();
    errorSpy.mockRestore();
  });

  test('a returning user gets the Recent list in place of the starter-pack line', async () => {
    const bridge = createBridge([{ path: '/projects/recent', name: 'Recent Project' }]);
    await renderNavigator(bridge);

    expect(await screen.findByTestId('nav-create-new')).not.toBeNull();
    expect(screen.getByTestId('nav-open')).not.toBeNull();
    expect(screen.getByTestId('nav-clone')).not.toBeNull();
    expect(await screen.findByTestId('nav-recent-list')).not.toBeNull();
    expect(screen.queryByTestId('nav-starter-packs')).toBeNull();
  });

  test('listRecent failure falls back to the three-card launcher, not the packs view', async () => {
    const bridge = createBridge([]);
    bridge.project.listRecent = vi.fn(() => Promise.reject(new Error('boom')));
    await renderNavigator(bridge);

    expect(await screen.findByTestId('nav-create-new')).not.toBeNull();
    expect(screen.getByTestId('nav-open')).not.toBeNull();
    expect(screen.getByTestId('nav-clone')).not.toBeNull();
    expect(screen.queryByTestId('nav-starter-packs')).toBeNull();
    expect(screen.getByTestId('nav-error-banner')).not.toBeNull();
  });
});
