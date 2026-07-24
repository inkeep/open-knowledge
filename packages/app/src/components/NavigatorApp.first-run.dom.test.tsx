import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
    description: '',
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

// Stub the pack grid: one card per pack whose click fires onPackSelect, so the
// picker dialog's wiring can be asserted without the real grid. `iconForPack` is
// stubbed too — NavigatorApp imports it for the pill row.
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
  render(<NavigatorApp bridge={bridge as never} />);
  await waitFor(() => expect(bridge.project.listRecent).toHaveBeenCalledTimes(1));
}

// Import the component AFTER the mocks above register so its transitive
// dependencies bind to the stubs rather than the real modules.
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

    // The four doors are the primary actions on first run, same as for a
    // returning user — the layout no longer swaps between the two states.
    expect(await screen.findByTestId('nav-create-new')).not.toBeNull();
    expect(screen.getByTestId('nav-open')).not.toBeNull();
    expect(screen.getByTestId('nav-open-file')).not.toBeNull();
    expect(screen.getByTestId('nav-clone')).not.toBeNull();

    // Starter-pack line: first three packs as pills, rest behind the count.
    const row = await screen.findByTestId('nav-starter-packs');
    expect(row.textContent).toContain('or use a starter pack');
    expect(screen.getByTestId('nav-pack-pill-knowledge-base')).not.toBeNull();
    expect(screen.getByTestId('nav-pack-pill-software-lifecycle')).not.toBeNull();
    expect(screen.getByTestId('nav-pack-pill-codebase-wiki')).not.toBeNull();
    // Packs 4 and 5 are not pills — they live behind the overflow affordance.
    expect(screen.queryByTestId('nav-pack-pill-plain-notes')).toBeNull();
    expect(screen.getByTestId('nav-pack-more').textContent).toContain('2');
  });

  test('the overflow count carries an accessible name naming the total', async () => {
    const bridge = createBridge([]);
    await renderNavigator(bridge);

    // "+2 more" alone is a vague label out of visual context; the accessible
    // name has to say what the count refers to.
    const more = await screen.findByTestId('nav-pack-more');
    expect(more.getAttribute('aria-label')).toBe('See all 5 starter packs');
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
      // The full pack list (not a name string) threads through so the dialog
      // can look up the chosen pack's display metadata.
      expect(dialog.getAttribute('data-pack-count')).toBe('5');
    });
  });

  test('the overflow count opens the picker, and picking there opens the create dialog', async () => {
    const bridge = createBridge([]);
    await renderNavigator(bridge);

    fireEvent.click(await screen.findByTestId('nav-pack-more'));

    // The picker shows every pack — including the ones the pill row omitted.
    const card = await screen.findByTestId('pack-card-plain-notes');
    fireEvent.click(card);

    await waitFor(() => {
      const dialog = screen.getByTestId('create-project-dialog');
      expect(dialog.getAttribute('data-open')).toBe('true');
      expect(dialog.getAttribute('data-pack-id')).toBe('plain-notes');
      // Same assertion as the pill path: both routes must thread the full list,
      // not just the chosen id, or the dialog loses the pack's display metadata.
      expect(dialog.getAttribute('data-pack-count')).toBe('5');
    });
    // Picking dismisses the picker rather than stacking it under the create
    // dialog.
    await waitFor(() => expect(screen.queryByTestId('nav-pack-picker')).toBeNull());
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

    // Open via a pack pill → dialog carries the pre-selected pack.
    fireEvent.click(await screen.findByTestId('nav-pack-pill-knowledge-base'));
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

    // Reopen via the blank "Create new project" door — the stale packId must
    // not leak in, or the blank-create path would silently seed a pack.
    fireEvent.click(screen.getByTestId('nav-create-new'));
    await waitFor(() => {
      const dialog = screen.getByTestId('create-project-dialog');
      expect(dialog.getAttribute('data-open')).toBe('true');
      expect(dialog.getAttribute('data-pack-id')).toBe('');
    });
  });

  test('listPacks failure drops the pack line entirely, leaving the four cards', async () => {
    // Deferred so the test owns the settle moment. The row renders nothing for
    // BOTH the in-flight and the failed state, so an absence assertion is only
    // meaningful once the fetch has provably settled — otherwise it passes
    // because the fetch never finished, not because the component degraded.
    // `waitFor` cannot supply that proof: it resolves on the first non-throwing
    // check, so wrapping an already-true absence assertion in it is a no-op.
    let settle: (result: unknown) => void = () => {};
    const listPacks = vi.fn(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    listPacksImpl = listPacks;
    // The failure path logs before it clears the pack list, so the log is the
    // observable edge of the settle — and that it logs at all is the contract
    // (a silently swallowed fetch failure would be the defect).
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bridge = createBridge([]);
    await renderNavigator(bridge);

    // In flight: the row holds its space empty rather than flashing a stub.
    await waitFor(() => expect(listPacks).toHaveBeenCalled());
    expect(screen.queryByTestId('nav-starter-packs')).toBeNull();

    settle({ ok: false, error: { kind: 'internal', message: 'boom' } });
    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        '[NavigatorApp] listPacks returned error:',
        expect.anything(),
      ),
    );

    // Settled and degraded: still nothing, and the four cards are already a
    // complete path forward without it.
    expect(await screen.findByTestId('nav-create-new')).not.toBeNull();
    expect(screen.queryByTestId('nav-starter-packs')).toBeNull();
    expect(screen.queryByTestId('nav-pack-more')).toBeNull();
    errorSpy.mockRestore();
  });

  test('a thrown listPacks drops the pack line too, leaving the four cards', async () => {
    // Structurally distinct from the `ok: false` case above: a transport-level
    // throw lands in the catch, not the else. Both must degrade the same way,
    // and only a test per branch keeps that true through a refactor.
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
    // A rejected listRecent leaves `recents` empty — but an empty-because-failed
    // fetch must NOT read as "brand-new user" and offer scaffolding to someone
    // who already has projects.
    const bridge = createBridge([]);
    bridge.project.listRecent = vi.fn(() => Promise.reject(new Error('boom')));
    await renderNavigator(bridge);

    expect(await screen.findByTestId('nav-create-new')).not.toBeNull();
    expect(screen.getByTestId('nav-open')).not.toBeNull();
    expect(screen.getByTestId('nav-clone')).not.toBeNull();
    // The starter-pack line must be absent.
    expect(screen.queryByTestId('nav-starter-packs')).toBeNull();
    // The failure surfaces the error banner.
    expect(screen.getByTestId('nav-error-banner')).not.toBeNull();
  });
});
