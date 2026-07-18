import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  __resetLocalMenuActionBusForTests,
  subscribeLocalMenuAction,
} from '@/lib/local-menu-action-bus';
import { __resetViewMenuStateForTests, setViewMenuState } from '@/lib/view-menu-state-store';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

type CommandDialogProps = {
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title?: string;
  description?: string;
  className?: string;
  commandProps?: Record<string, unknown>;
  transition?: unknown;
  placement?: unknown;
};
type CommandItemProps = {
  children?: ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
  value?: string;
  [key: string]: unknown;
};

let activeDocName: string | null = 'docs/active';
// Loosely typed so parity tests can set folder / asset / missing targets to
// exercise the contextual-command projection.
let activeTarget: { kind: string; [key: string]: unknown } | null = {
  kind: 'doc',
  docName: 'docs/active',
};
let requestDocPanelTabCalls: string[] = [];
let seedDialogProps: Array<{ open: boolean }> = [];
let newItemDialogProps: Array<{ open: boolean; kind: string; initialDir: string }> = [];
let createProjectDialogProps: Array<{ open: boolean; bridge: unknown }> = [];
let reportBugDialogProps: Array<{ open: boolean }> = [];
let commandDialogProps: CommandDialogProps[] = [];
let refreshInstallStatesCalls = 0;
const refreshInstallStates = () => {
  refreshInstallStatesCalls += 1;
};
const installedAgentStates = {
  codex: { installed: false },
  'claude-code': { installed: false },
  cursor: { installed: false },
};
const workspaceValue = { rootPath: '/workspace' };
let pageListLoading = false;
// Comfortably longer than two warming-poll cadences (600ms each), so a test can
// assert that a stopped poll fires no further requests.
const COMMAND_PALETTE_POLL_GRACE_MS = 1400;

import * as actualLinguiMacro from '@lingui/react/macro';

mock.module('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{(value === 1 ? one : other).replace('#', String(value))}</>
  ),
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

mock.module('@/components/ui/command', () => ({
  CommandDialog: (props: CommandDialogProps) => {
    commandDialogProps.push(props);
    return props.open ? (
      <div
        aria-describedby="command-palette-description"
        aria-label={props.title}
        className={props.className}
        role="dialog"
      >
        <p id="command-palette-description">{props.description}</p>
        {props.children}
      </div>
    ) : null;
  },
  CommandEmpty: ({ children }: { children?: ReactNode }) => <div role="status">{children}</div>,
  CommandGroup: ({ children, heading }: { children?: ReactNode; heading?: ReactNode }) => (
    <section aria-label={typeof heading === 'string' ? heading : undefined}>
      {heading ? <h2>{heading}</h2> : null}
      {children}
    </section>
  ),
  CommandInput: ({
    onValueChange,
    value,
    ...props
  }: {
    onValueChange?: (value: string) => void;
    value?: string;
    [key: string]: unknown;
  }) => (
    <input
      {...props}
      aria-label="Command search"
      value={value}
      onChange={(event) => onValueChange?.(event.currentTarget.value)}
    />
  ),
  CommandItem: ({ children, disabled, onSelect, ...props }: CommandItemProps) => (
    <button type="button" role="option" disabled={disabled} onClick={() => onSelect?.()} {...props}>
      {children}
    </button>
  ),
  CommandList: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
    <div role="listbox" {...props}>
      {children}
    </div>
  ),
  CommandShortcut: ({ children }: { children?: ReactNode }) => (
    <span data-testid="command-shortcut">{children}</span>
  ),
}));

mock.module('@/components/doc-panel-events', () => ({
  requestDocPanelTab: (tab: string) => {
    requestDocPanelTabCalls.push(tab);
  },
}));

mock.module('@/components/NewItemDialog', () => ({
  NewItemDialog: (props: { open: boolean; kind: string; initialDir: string }) => {
    newItemDialogProps.push(props);
    return (
      <div data-kind={props.kind} data-open={String(props.open)} data-testid="new-item-dialog" />
    );
  },
}));

mock.module('@/components/SeedDialog', () => ({
  SeedDialog: (props: { open: boolean }) => {
    seedDialogProps.push(props);
    return <div data-open={String(props.open)} data-testid="seed-dialog" />;
  },
}));

mock.module('@/components/CreateProjectDialog', () => ({
  CreateProjectDialog: (props: { open: boolean; bridge: unknown }) => {
    createProjectDialogProps.push(props);
    return (
      <div
        data-open={String(props.open)}
        data-has-bridge={String(props.bridge !== null)}
        data-testid="create-project-dialog"
      />
    );
  },
}));

mock.module('@/components/ReportBugDialog', () => ({
  ReportBugDialog: (props: { open: boolean }) => {
    reportBugDialogProps.push(props);
    return <div data-open={String(props.open)} data-testid="report-bug-dialog" />;
  },
}));

mock.module('@/components/PageListContext', () => ({
  usePageList: () => ({
    pages: new Set<string>(),
    pageTitles: new Map<string, string>(),
    pageMeta: new Map<string, unknown>(),
    folderPaths: new Set<string>(),
    filePaths: new Set<string>(),
    loading: pageListLoading,
  }),
}));

mock.module('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName,
    activeTarget,
  }),
}));

mock.module('@/lib/use-workspace', () => ({
  useWorkspace: () => workspaceValue,
}));

mock.module('./handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({
    states: installedAgentStates,
    refresh: refreshInstallStates,
  }),
}));

mock.module('./handoff/useHandoffDispatch', () => ({
  buildHandoffInput: ({ docName, workspace }: { docName: string | null; workspace: unknown }) =>
    docName && workspace ? { docName, workspace } : null,
  useHandoffDispatch: () => ({
    dispatch: mock(() => Promise.resolve()),
  }),
}));

mock.module('@/components/command-palette-tag-search', () => ({
  TAG_QUERY_PREFIX: 'tag:',
  parseTagPaletteQuery: () => ({ kind: 'normal' }),
  filterTagList: () => [],
  fetchTagsList: mock(() => Promise.resolve([])),
  fetchDocsForTag: mock(() => Promise.resolve([])),
}));

// The cached worktree model is read via useWorktrees (backed by window.okDesktop,
// not the bridge prop). Default null so the existing suite sees no Worktrees
// group; the dedicated test sets a model.
let worktreeModelMock: import('@inkeep/open-knowledge-core').WorktreeSelectorModel | null = null;
mock.module('@/hooks/use-worktrees', () => ({
  useWorktrees: () => worktreeModelMock,
}));
const refreshWorktreesMock = mock(() => {});
mock.module('@/lib/worktree-store', () => ({ refreshWorktrees: refreshWorktreesMock }));

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
          recent('Alpha', '/projects/alpha'),
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
    worktree: {
      create: mock(() =>
        Promise.resolve({
          ok: true as const,
          path: '/projects/current/.ok/worktrees/feature-x',
          created: true,
        }),
      ),
    },
    // Surfaces the backfilled bridge-invoke commands reach.
    update: {
      checkNow: mock(() => Promise.resolve()),
    },
    mcpWiring: {
      reconfigure: mock(() => Promise.resolve(true)),
    },
    spellcheck: {
      toggle: mock(() => Promise.resolve(true)),
    },
    shell: {
      openExternal: mock(() => Promise.resolve()),
    },
  };
}

async function renderPalette({
  bridge = createBridge(),
  docName = 'docs/active',
}: {
  bridge?: ReturnType<typeof createBridge> | null;
  docName?: string | null;
} = {}) {
  activeDocName = docName;
  activeTarget = docName ? { kind: 'doc', docName } : null;
  const onOpenChange = mock(() => {});
  const { CommandPalette } = await import('./CommandPalette');
  render(<CommandPalette bridge={bridge as never} open={true} onOpenChange={onOpenChange} />);
  await waitFor(() => expect(screen.getByRole('dialog')).not.toBeNull());
  return { bridge, onOpenChange };
}

async function setQuery(value: string) {
  fireEvent.change(screen.getByLabelText('Command search'), { target: { value } });
  await waitFor(() => {
    expect((screen.getByLabelText('Command search') as HTMLInputElement).value).toBe(value);
  });
}

describe('CommandPalette DOM behavior', () => {
  beforeEach(() => {
    cleanup();
    activeDocName = 'docs/active';
    activeTarget = { kind: 'doc', docName: 'docs/active' };
    pageListLoading = false;
    requestDocPanelTabCalls = [];
    seedDialogProps = [];
    newItemDialogProps = [];
    createProjectDialogProps = [];
    reportBugDialogProps = [];
    commandDialogProps = [];
    refreshInstallStatesCalls = 0;
    worktreeModelMock = null;
    refreshWorktreesMock.mockClear();
    window.location.hash = '';
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 })),
    ) as never;
  });

  test('hides active-document commands without an active doc and opens the graph panel when one exists', async () => {
    await renderPalette({ bridge: null, docName: null });

    expect(document.body.textContent).not.toContain('No active doc');
    expect(screen.queryByTestId('command-palette-open-graph')).toBeNull();
    expect(screen.queryByText('Open with AI Codex')).toBeNull();

    cleanup();
    await renderPalette({ bridge: null, docName: 'docs/active' });

    fireEvent.click(screen.getByTestId('command-palette-open-graph'));

    expect(requestDocPanelTabCalls).toEqual(['graph']);
  });

  test('routes project commands through runtime bridge entry points and exposes switch-project search tokens', async () => {
    const bridge = createBridge();
    const { onOpenChange } = await renderPalette({ bridge });
    await waitFor(() => expect(bridge.project.listRecent).toHaveBeenCalledTimes(1));
    expect(refreshInstallStatesCalls).toBeGreaterThan(0);

    const switchProject = screen.getByTestId('command-palette-switch-project');
    expect(switchProject.textContent).toContain('Switch project');
    expect(switchProject.textContent).toMatch(/⌘⇧N|Ctrl Shift P/);
    expect(switchProject.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Start fresh in a new folder');

    expect(screen.getByTestId('command-palette-new-file').textContent).toMatch(/⌘ N|Ctrl N/);
    expect(screen.getByTestId('command-palette-new-folder').textContent).toMatch(
      /⇧⌘ N|Ctrl Shift N/,
    );
    expect(screen.getByTestId('command-palette-open-folder').textContent).toMatch(/⌘ O|Ctrl O/);

    fireEvent.click(switchProject);
    await waitFor(() => expect(bridge.navigator.open).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId('command-palette-open-folder'));
    await waitFor(() => {
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/chosen/folder',
        target: 'new-window',
        entryPoint: 'pick-existing',
      });
    });

    fireEvent.click(screen.getByTestId('command-palette-recent-/projects/alpha'));
    await waitFor(() => {
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/projects/alpha',
        target: 'new-window',
        entryPoint: 'recents',
      });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);

    await setQuery('navigator');
    expect(screen.getByTestId('command-palette-switch-project')).not.toBeNull();

    await setQuery('manage');
    expect(screen.queryByTestId('command-palette-switch-project')).toBeNull();
  });

  test('new-folder shortcut is desktop-only while new-file shortcut is always visible', async () => {
    await renderPalette({ bridge: null });

    expect(screen.getByTestId('command-palette-new-file').textContent).toMatch(/⌘ N|Ctrl N/);
    expect(screen.getByTestId('command-palette-new-folder').textContent).not.toMatch(
      /⇧⌘ N|Ctrl Shift N/,
    );
  });

  test('new-file command closes the palette and opens the New Item dialog with kind file', async () => {
    const { onOpenChange } = await renderPalette({ bridge: null });

    fireEvent.click(screen.getByTestId('command-palette-new-file'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    const dialogKind = (kind: 'file' | 'folder') =>
      screen.getAllByTestId('new-item-dialog').find((el) => el.getAttribute('data-kind') === kind);
    await waitFor(() => expect(dialogKind('file')?.getAttribute('data-open')).toBe('true'));
    expect(dialogKind('folder')?.getAttribute('data-open')).toBe('false');
  });

  test('new-folder command closes the palette and opens the New Item dialog with kind folder', async () => {
    const { onOpenChange } = await renderPalette({ bridge: null });

    fireEvent.click(screen.getByTestId('command-palette-new-folder'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    const dialogKind = (kind: 'file' | 'folder') =>
      screen.getAllByTestId('new-item-dialog').find((el) => el.getAttribute('data-kind') === kind);
    await waitFor(() => expect(dialogKind('folder')?.getAttribute('data-open')).toBe('true'));
    expect(dialogKind('file')?.getAttribute('data-open')).toBe('false');
  });

  test('settings command is searchable by preferences/config, closes the palette, and routes through the canonical hash', async () => {
    const { onOpenChange } = await renderPalette({ bridge: null });

    await setQuery('preferences');
    const settingsByPreference = screen.getByTestId('command-palette-settings');
    expect(settingsByPreference.textContent).toContain('Settings');
    expect(settingsByPreference.textContent).toMatch(/⌘,|Ctrl ,/);
    expect(settingsByPreference.querySelector('svg[aria-hidden="true"]')).not.toBeNull();

    await setQuery('config');
    expect(screen.getByTestId('command-palette-settings')).not.toBeNull();

    fireEvent.click(screen.getByTestId('command-palette-settings'));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    const { SETTINGS_OPEN_HASH } = await import('@/lib/use-settings-route');
    expect(window.location.hash).toBe(SETTINGS_OPEN_HASH);
  });

  test('new-project command is desktop-only, searchable by scaffold tokens, and opens CreateProjectDialog', async () => {
    await renderPalette({ bridge: null });

    await setQuery('new project');
    expect(screen.queryByTestId('command-palette-new-project')).toBeNull();
    expect(screen.queryByTestId('create-project-dialog')).toBeNull();

    cleanup();
    const bridge = createBridge();
    const { onOpenChange } = await renderPalette({ bridge });

    await setQuery('scaffold');
    const newProject = screen.getByTestId('command-palette-new-project');
    expect(newProject.textContent).toContain('New project');

    fireEvent.click(newProject);

    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => {
      expect(screen.getByTestId('create-project-dialog').getAttribute('data-open')).toBe('true');
    });
    expect(createProjectDialogProps.at(-1)?.bridge).toBe(bridge);
  });

  test('report-a-bug command is desktop-only, searchable by issue tokens, and opens ReportBugDialog', async () => {
    await renderPalette({ bridge: null });

    await setQuery('bug');
    expect(screen.queryByTestId('command-palette-report-bug')).toBeNull();
    expect(screen.queryByTestId('report-bug-dialog')).toBeNull();

    cleanup();
    const bridge = createBridge();
    const { onOpenChange } = await renderPalette({ bridge });

    await setQuery('issue');
    const reportBug = screen.getByTestId('command-palette-report-bug');
    expect(reportBug.textContent).toContain('Report a bug');

    fireEvent.click(reportBug);

    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => {
      expect(screen.getByTestId('report-bug-dialog').getAttribute('data-open')).toBe('true');
    });
    expect(reportBugDialogProps.at(-1)?.open).toBe(true);
  });

  test('starter-pack command is searchable, participates in empty-state aggregation, and opens SeedDialog after closing', async () => {
    const { onOpenChange } = await renderPalette({ bridge: null });

    await setQuery('scaffold');
    expect(screen.queryByText('No matching commands.')).toBeNull();
    const seedItem = screen.getByTestId('command-palette-initialize-starter-pack');
    expect(seedItem.textContent).toContain('Initialize starter pack');
    expect(seedItem.querySelector('svg[aria-hidden="true"]')).not.toBeNull();

    fireEvent.click(seedItem);

    expect(onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => {
      expect(screen.getByTestId('seed-dialog').getAttribute('data-open')).toBe('true');
    });
    expect(seedDialogProps.at(-1)?.open).toBe(true);
  });

  test('CommandDialog receives no transition or placement prop from CommandPalette', async () => {
    await renderPalette();

    expect(commandDialogProps.at(-1)?.transition).toBeUndefined();
    expect(commandDialogProps.at(-1)?.placement).toBeUndefined();
  });

  test('during cold load, a typed query shows a preparing state and never fires the body search', async () => {
    pageListLoading = true;
    await renderPalette({ bridge: null });

    await setQuery('rename');

    await waitFor(() =>
      expect(screen.getByTestId('command-palette-search-preparing')).not.toBeNull(),
    );
    // The misleading failure / empty copy must be suppressed while warming.
    expect(screen.queryByText('Search failed.')).toBeNull();
    expect(screen.queryByText('No matching commands.')).toBeNull();

    const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
    expect(fetchMock.mock.calls.some((call) => call[0] === '/api/search')).toBe(false);
  });

  test('once the page list has loaded, a typed query fires the body search with no preparing state', async () => {
    await renderPalette({ bridge: null });

    await setQuery('rename');

    await waitFor(() => {
      const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
      expect(fetchMock.mock.calls.some((call) => call[0] === '/api/search')).toBe(true);
    });
    expect(screen.queryByTestId('command-palette-search-preparing')).toBeNull();
  });

  test('a query typed during cold load auto-fires the body search once the page list loads', async () => {
    pageListLoading = true;
    const { CommandPalette } = await import('./CommandPalette');
    const onOpenChange = mock(() => {});
    const { rerender } = render(
      <CommandPalette bridge={null} open={true} onOpenChange={onOpenChange} />,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).not.toBeNull());

    await setQuery('rename');
    await waitFor(() =>
      expect(screen.getByTestId('command-palette-search-preparing')).not.toBeNull(),
    );
    const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
    expect(fetchMock.mock.calls.some((call) => call[0] === '/api/search')).toBe(false);

    // The page list finishes its initial load: the effect's `pagesLoading`
    // dependency flips, the effect re-runs, and the body search fires. This is
    // the "search runs automatically once the workspace is ready" contract.
    pageListLoading = false;
    rerender(<CommandPalette bridge={null} open={true} onOpenChange={onOpenChange} />);

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => call[0] === '/api/search')).toBe(true),
    );
    expect(screen.queryByTestId('command-palette-search-preparing')).toBeNull();
  });

  test('server warming (ready:false) shows the preparing state and polls until the index is ready', async () => {
    // First /api/search answers warming; later answers ready with a hit. Any
    // non-search fetch (e.g. the semantic-capability probe) stays the default.
    let searchCalls = 0;
    globalThis.fetch = mock((input: unknown) => {
      if (input === '/api/search') {
        searchCalls += 1;
        const body =
          searchCalls >= 2
            ? { results: [{ kind: 'page', path: 'arch', title: 'Arch' }], ready: true }
            : { results: [], ready: false };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    }) as never;

    await renderPalette({ bridge: null });
    await setQuery('arch');

    // Warming response -> preparing status, not a failure, no premature empty.
    await waitFor(() =>
      expect(screen.getByTestId('command-palette-search-preparing')).not.toBeNull(),
    );
    expect(screen.queryByText('Search failed.')).toBeNull();

    // The poll re-fires the search; once it reports ready, the preparing state
    // clears without the user re-typing.
    await waitFor(() => expect(searchCalls).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    await waitFor(() =>
      expect(screen.queryByTestId('command-palette-search-preparing')).toBeNull(),
    );
  });

  test('closing the palette mid-warming stops the poll (no further /api/search calls)', async () => {
    globalThis.fetch = mock((input: unknown) => {
      if (input === '/api/search') {
        return Promise.resolve(
          new Response(JSON.stringify({ results: [], ready: false }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    }) as never;

    const { CommandPalette } = await import('./CommandPalette');
    const onOpenChange = mock(() => {});
    const { rerender } = render(
      <CommandPalette bridge={null} open={true} onOpenChange={onOpenChange} />,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).not.toBeNull());
    await setQuery('arch');
    await waitFor(() =>
      expect(screen.getByTestId('command-palette-search-preparing')).not.toBeNull(),
    );

    const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
    const searchCalls = () =>
      fetchMock.mock.calls.filter((call) => call[0] === '/api/search').length;
    const callsAtClose = searchCalls();

    // Close the palette: the effect cleanup must cancel the in-flight poll.
    rerender(<CommandPalette bridge={null} open={false} onOpenChange={onOpenChange} />);

    // Past two poll cadences, the count must not grow.
    await new Promise((resolve) => setTimeout(resolve, COMMAND_PALETTE_POLL_GRACE_MS));
    expect(searchCalls()).toBe(callsAtClose);
  });

  test('a transient error while warming keeps polling and recovers, never showing "Search failed."', async () => {
    let call = 0;
    globalThis.fetch = mock((input: unknown) => {
      if (input === '/api/search') {
        call += 1;
        if (call === 1) {
          return Promise.resolve(
            new Response(JSON.stringify({ results: [], ready: false }), { status: 200 }),
          );
        }
        if (call === 2) return Promise.reject(new Error('network blip'));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              results: [{ kind: 'page', path: 'arch', title: 'Arch' }],
              ready: true,
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    }) as never;

    await renderPalette({ bridge: null });
    await setQuery('arch');
    await waitFor(() =>
      expect(screen.getByTestId('command-palette-search-preparing')).not.toBeNull(),
    );

    // The error on call #2 must not abandon to "Search failed." — warming keeps
    // polling, and call #3 (ready) clears the preparing state.
    await waitFor(() => expect(call).toBeGreaterThanOrEqual(3), { timeout: 3000 });
    expect(screen.queryByText('Search failed.')).toBeNull();
    await waitFor(() =>
      expect(screen.queryByTestId('command-palette-search-preparing')).toBeNull(),
    );
  });

  test('surfaces worktrees of the current project — opens an existing one and creates one on demand', async () => {
    worktreeModelMock = {
      mainRoot: '/projects/current',
      currentBranch: 'main',
      entries: [
        // The current window's own worktree — excluded (no self-switch).
        {
          branch: 'main',
          worktreePath: '/projects/current',
          isCurrent: true,
          isMain: true,
          locked: false,
        },
        // An existing sibling worktree — opens its window directly.
        {
          branch: 'dev',
          worktreePath: '/projects/current/.ok/worktrees/dev',
          isCurrent: false,
          isMain: false,
          locked: false,
        },
        // A branch with no worktree yet — created on demand, then opened.
        {
          branch: 'feature-x',
          worktreePath: null,
          isCurrent: false,
          isMain: false,
          locked: false,
        },
      ],
    };
    const { bridge } = await renderPalette();

    // The current worktree is not offered as a switch target.
    expect(screen.queryByTestId('command-palette-worktree-main')).toBeNull();

    // Existing worktree → open its window with the worktree entry point.
    fireEvent.click(screen.getByTestId('command-palette-worktree-dev'));
    await waitFor(() => {
      expect(bridge?.project.open).toHaveBeenCalledWith({
        path: '/projects/current/.ok/worktrees/dev',
        target: 'new-window',
        entryPoint: 'worktree',
      });
    });

    // Un-opened branch → create the worktree, refresh the cache, then open it.
    fireEvent.click(screen.getByTestId('command-palette-worktree-feature-x'));
    await waitFor(() => {
      expect(bridge?.worktree.create).toHaveBeenCalledWith({
        branch: 'feature-x',
        createBranch: false,
      });
    });
    await waitFor(() => {
      expect(bridge?.project.open).toHaveBeenCalledWith({
        path: '/projects/current/.ok/worktrees/feature-x',
        target: 'new-window',
        entryPoint: 'worktree',
      });
    });
    expect(refreshWorktreesMock).toHaveBeenCalled();
  });
});

describe('NavigationItem path subtitle', () => {
  beforeEach(() => {
    cleanup();
  });

  // Every result row shows its full path so same-named files are
  // distinguishable. Two files share the basename `data.csv`; the row content
  // must carry each one's distinct path.
  test('a file result row renders its path so same-named siblings are distinguishable', async () => {
    const { NavigationItem } = await import('./CommandPalette');
    const fileA = {
      kind: 'file' as const,
      path: 'reports/q3/data.csv',
      name: 'data.csv',
      title: 'data.csv',
      score: 1,
    };
    const fileB = {
      kind: 'file' as const,
      path: 'exports/legacy/data.csv',
      name: 'data.csv',
      title: 'data.csv',
      score: 1,
    };
    render(
      <>
        <NavigationItem entry={fileA as never} query="data.csv" onSelect={() => {}} />
        <NavigationItem entry={fileB as never} query="data.csv" onSelect={() => {}} />
      </>,
    );

    const rowA = screen.getByTestId('command-palette-nav-file-reports/q3/data.csv');
    const rowB = screen.getByTestId('command-palette-nav-file-exports/legacy/data.csv');
    expect(rowA.textContent).toContain('reports/q3/data.csv');
    expect(rowB.textContent).toContain('exports/legacy/data.csv');
  });

  test('file and folder rows render sidebar-aligned icons and extension badges', async () => {
    const { NavigationItem } = await import('./CommandPalette');
    render(
      <>
        <NavigationItem
          entry={{ kind: 'file' as const, path: 'notes/readme', name: 'readme' }}
          onSelect={() => {}}
        />
        <NavigationItem
          entry={{
            kind: 'file' as const,
            path: 'docs/component',
            name: 'component',
            docExt: '.mdx',
          }}
          onSelect={() => {}}
        />
        <NavigationItem
          entry={{
            kind: 'file' as const,
            path: 'assets/photo.png',
            name: 'photo.png',
            bodyIndexed: false,
          }}
          onSelect={() => {}}
        />
        <NavigationItem
          entry={{
            kind: 'file' as const,
            path: 'media/demo.mp4',
            name: 'demo.mp4',
            bodyIndexed: false,
          }}
          onSelect={() => {}}
        />
        <NavigationItem
          entry={{
            kind: 'file' as const,
            path: 'audio/theme.mp3',
            name: 'theme.mp3',
            bodyIndexed: false,
          }}
          onSelect={() => {}}
        />
        <NavigationItem
          entry={{
            kind: 'file' as const,
            path: 'src/index.ts',
            name: 'index.ts',
            bodyIndexed: false,
          }}
          onSelect={() => {}}
        />
        <NavigationItem
          entry={{
            kind: 'file' as const,
            path: 'recents/screenshot.png',
            name: 'screenshot.png',
          }}
          onSelect={() => {}}
        />
        <NavigationItem
          entry={{ kind: 'folder' as const, path: 'docs', name: 'docs' }}
          onSelect={() => {}}
        />
      </>,
    );

    const markdownRow = screen.getByTestId('command-palette-nav-file-notes/readme');
    expect(markdownRow.querySelector('[data-testid="file-entry-icon-markdown"]')).not.toBeNull();
    expect(markdownRow.querySelector('[data-testid="file-entry-extension-badge"]')).toBeNull();

    const mdxRow = screen.getByTestId('command-palette-nav-file-docs/component');
    expect(mdxRow.querySelector('[data-testid="file-entry-icon-markdown"]')).not.toBeNull();
    expect(mdxRow.textContent).toContain('MDX');

    const pngRow = screen.getByTestId('command-palette-nav-file-assets/photo.png');
    expect(pngRow.querySelector('[data-testid="file-entry-icon-image"]')).not.toBeNull();
    expect(pngRow.textContent).toContain('PNG');

    const videoRow = screen.getByTestId('command-palette-nav-file-media/demo.mp4');
    expect(videoRow.querySelector('[data-testid="file-entry-icon-video"]')).not.toBeNull();
    expect(videoRow.textContent).toContain('MP4');

    const audioRow = screen.getByTestId('command-palette-nav-file-audio/theme.mp3');
    expect(audioRow.querySelector('[data-testid="file-entry-icon-audio"]')).not.toBeNull();
    expect(audioRow.textContent).toContain('MP3');

    const genericFileRow = screen.getByTestId('command-palette-nav-file-src/index.ts');
    expect(genericFileRow.querySelector('[data-testid="file-entry-icon-file"]')).not.toBeNull();
    expect(genericFileRow.querySelector('[data-testid="file-entry-icon-image"]')).toBeNull();
    expect(genericFileRow.textContent).toContain('TS');

    const recentPngRow = screen.getByTestId('command-palette-nav-file-recents/screenshot.png');
    expect(recentPngRow.querySelector('[data-testid="file-entry-icon-image"]')).not.toBeNull();
    expect(recentPngRow.querySelector('[data-testid="file-entry-icon-markdown"]')).toBeNull();

    const folderRow = screen.getByTestId('command-palette-nav-folder-docs');
    expect(folderRow.querySelector('[data-file-entry-icon="folder"]')).not.toBeNull();
    expect(folderRow.querySelector('[data-testid="file-entry-extension-badge"]')).toBeNull();
  });
});

// Ratchet C + acceptance criteria for the menu-parity backfill. Honest limit: cmdk and
// the hooks are mocked, so these assert the registry-driven branch emits the row
// and wires the dispatch under its declared enabling context — not cmdk's own
// filtering (covered by the palette DOM tests above + a Playwright smoke).
describe('Cmd+K menu-parity backfill', () => {
  let busActions: string[];
  let unsubscribeBus: (() => void) | null = null;

  beforeEach(() => {
    cleanup();
    __resetLocalMenuActionBusForTests();
    __resetViewMenuStateForTests();
    activeDocName = 'docs/active';
    activeTarget = { kind: 'doc', docName: 'docs/active' };
    pageListLoading = false;
    window.location.hash = '';
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 })),
    ) as never;
    // Panels visible + a live terminal so the state-aware View toggles render
    // their "Hide …" variant and Kill Terminal is enabled.
    setViewMenuState({
      sidebarVisible: true,
      docPanelVisible: true,
      terminalVisible: true,
      terminalLive: true,
    });
    busActions = [];
    unsubscribeBus = subscribeLocalMenuAction((action) => busActions.push(action));
  });

  afterEach(() => {
    unsubscribeBus?.();
    unsubscribeBus = null;
    __resetLocalMenuActionBusForTests();
    __resetViewMenuStateForTests();
  });

  // Each id-backed backfill row renders under a matching query and emits its
  // OkMenuAction id on the bus when selected.
  const ID_BACKED: Array<{ testid: string; query: string; id: string }> = [
    {
      testid: 'command-palette-new-from-template',
      query: 'new from template',
      id: 'new-from-template',
    },
    { testid: 'command-palette-toggle-sidebar', query: 'sidebar', id: 'toggle-sidebar' },
    { testid: 'command-palette-toggle-doc-panel', query: 'document panel', id: 'toggle-doc-panel' },
    { testid: 'command-palette-toggle-terminal', query: 'hide terminal', id: 'toggle-terminal' },
    {
      testid: 'command-palette-toggle-show-hidden-files',
      query: 'hidden files',
      id: 'toggle-show-hidden-files',
    },
    {
      testid: 'command-palette-toggle-show-ok-folders',
      query: 'ok folders',
      id: 'toggle-show-ok-folders',
    },
    {
      testid: 'command-palette-toggle-show-only-markdown-files',
      query: 'only markdown',
      id: 'toggle-show-only-markdown-files',
    },
    {
      testid: 'command-palette-toggle-show-skills-section',
      query: 'skills section',
      id: 'toggle-show-skills-section',
    },
    { testid: 'command-palette-expand-all-tree', query: 'expand all', id: 'expand-all-tree' },
    { testid: 'command-palette-collapse-all-tree', query: 'collapse all', id: 'collapse-all-tree' },
    { testid: 'command-palette-new-terminal', query: 'new terminal', id: 'new-terminal' },
    { testid: 'command-palette-kill-terminal', query: 'kill terminal', id: 'kill-terminal' },
    { testid: 'command-palette-new-worktree', query: 'new worktree', id: 'new-worktree' },
    { testid: 'command-palette-switch-worktree', query: 'switch worktree', id: 'switch-worktree' },
    { testid: 'command-palette-close-tab', query: 'close tab', id: 'close-active-tab-or-window' },
    { testid: 'command-palette-rename', query: 'rename', id: 'rename' },
    { testid: 'command-palette-duplicate', query: 'duplicate', id: 'duplicate' },
    { testid: 'command-palette-move-to-trash', query: 'move to trash', id: 'move-to-trash' },
    {
      testid: 'command-palette-reveal-in-finder',
      query: 'reveal in finder',
      id: 'reveal-in-finder',
    },
    { testid: 'command-palette-copy-full-path', query: 'copy full path', id: 'copy-full-path' },
    {
      testid: 'command-palette-copy-relative-path',
      query: 'copy relative path',
      id: 'copy-relative-path',
    },
  ];

  for (const { testid, query, id } of ID_BACKED) {
    test(`AC1: "${id}" renders on query and emits on the bus`, async () => {
      await renderPalette({ bridge: createBridge() });
      await setQuery(query);
      const row = screen.getByTestId(testid);
      expect(row).not.toBeNull();
      fireEvent.click(row);
      expect(busActions).toContain(id);
    });
  }

  // Ratchet C completeness: every id classified as a palette command (shared with
  // the id-classification ratchet via command-menu-parity.test-helper) must be
  // covered by a rendered id-backed row above OR a pre-existing palette surface.
  // A future id classified into PALETTE_COMMAND_IDS with no rendered row — which
  // satisfies only Ratchets A/B — turns this red, closing the "classified but
  // unreachable" gap that the id ratchets alone cannot see.
  test('Ratchet C: every classified palette-command id renders a row or is a pre-existing surface', async () => {
    // Imported dynamically: the helper pulls in the command registry, and a
    // static import would evaluate the registry before the `mock.module`
    // calls above register — freezing real module bindings (e.g.
    // doc-panel-events) into it for every test in this file.
    const { PALETTE_COMMAND_IDS, PRE_EXISTING_PALETTE_IDS } = await import(
      '@/lib/command-menu-parity.test-helper'
    );
    const rendered = new Set(ID_BACKED.map((row) => row.id));
    const covered = new Set([...rendered, ...PRE_EXISTING_PALETTE_IDS]);
    const missing = [...PALETTE_COMMAND_IDS].filter((id) => !covered.has(id));
    expect(missing).toEqual([]);
    // No ID_BACKED row tests an id that isn't classified (stale row test).
    const staleRows = [...rendered].filter((id) => !PALETTE_COMMAND_IDS.has(id));
    expect(staleRows).toEqual([]);
    // The pre-existing escape hatch stays honest: every entry is still classified.
    const stalePreExisting = [...PRE_EXISTING_PALETTE_IDS].filter(
      (id) => !PALETTE_COMMAND_IDS.has(id),
    );
    expect(stalePreExisting).toEqual([]);
  });

  test('AC1: check-for-updates invokes bridge.update.checkNow', async () => {
    const { bridge } = await renderPalette({ bridge: createBridge() });
    await setQuery('check for updates');
    fireEvent.click(screen.getByTestId('command-palette-check-for-updates'));
    await waitFor(() => expect(bridge?.update.checkNow).toHaveBeenCalledTimes(1));
  });

  test('AC1: set-up-integrations invokes bridge.mcpWiring.reconfigure', async () => {
    const { bridge } = await renderPalette({ bridge: createBridge() });
    await setQuery('set up openknowledge integrations');
    fireEvent.click(screen.getByTestId('command-palette-set-up-integrations'));
    await waitFor(() => expect(bridge?.mcpWiring.reconfigure).toHaveBeenCalledTimes(1));
  });

  test('AC1: OpenKnowledge on GitHub opens the repository URL', async () => {
    const { bridge } = await renderPalette({ bridge: createBridge() });
    await setQuery('github');
    fireEvent.click(screen.getByTestId('command-palette-open-github'));
    expect(bridge?.shell.openExternal).toHaveBeenCalledWith(
      'https://github.com/inkeep/open-knowledge',
    );
  });

  test('AC1: OpenKnowledge on GitHub falls back to window.open on the web host', async () => {
    const openSpy = mock(() => null);
    const originalOpen = window.open;
    window.open = openSpy as unknown as typeof window.open;
    try {
      await renderPalette({ bridge: null });
      await setQuery('github');
      fireEvent.click(screen.getByTestId('command-palette-open-github'));
      expect(openSpy).toHaveBeenCalledWith(
        'https://github.com/inkeep/open-knowledge',
        '_blank',
        'noopener,noreferrer',
      );
    } finally {
      window.open = originalOpen;
    }
  });

  test('AC1: with no prop bridge, GitHub takes the web fallback and never the ambient window.okDesktop', async () => {
    // The palette's external-URL open is a pure function of the `bridge` prop:
    // a null prop bridge must take the web `window.open` path and must not
    // reach through to an ambient `window.okDesktop` global. Guards the
    // injected-bridge seam the shared opener relies on.
    const openSpy = mock(() => null);
    const ambientOpenExternal = mock(() => Promise.resolve());
    const originalOpen = window.open;
    window.open = openSpy as unknown as typeof window.open;
    (window as { okDesktop?: unknown }).okDesktop = {
      shell: { openExternal: ambientOpenExternal },
    };
    try {
      await renderPalette({ bridge: null });
      await setQuery('github');
      fireEvent.click(screen.getByTestId('command-palette-open-github'));
      expect(openSpy).toHaveBeenCalledWith(
        'https://github.com/inkeep/open-knowledge',
        '_blank',
        'noopener,noreferrer',
      );
      expect(ambientOpenExternal).not.toHaveBeenCalled();
    } finally {
      window.open = originalOpen;
      delete (window as { okDesktop?: unknown }).okDesktop;
    }
  });

  test('AC3: web host shows host-agnostic toggles but hides desktop-only commands', async () => {
    await renderPalette({ bridge: null });

    await setQuery('sidebar');
    expect(screen.queryByTestId('command-palette-toggle-sidebar')).not.toBeNull();
    await setQuery('expand all');
    expect(screen.queryByTestId('command-palette-expand-all-tree')).not.toBeNull();

    await setQuery('new terminal');
    expect(screen.queryByTestId('command-palette-new-terminal')).toBeNull();
    await setQuery('check for updates');
    expect(screen.queryByTestId('command-palette-check-for-updates')).toBeNull();
    await setQuery('rename');
    expect(screen.queryByTestId('command-palette-rename')).toBeNull();
  });

  test('AC5: the sidebar toggle label reflects view-menu-state', async () => {
    setViewMenuState({ sidebarVisible: true });
    await renderPalette({ bridge: createBridge() });
    await setQuery('sidebar');
    expect(screen.getByTestId('command-palette-toggle-sidebar').textContent).toContain(
      'Hide sidebar',
    );

    cleanup();
    setViewMenuState({ sidebarVisible: false });
    await renderPalette({ bridge: createBridge() });
    await setQuery('sidebar');
    expect(screen.getByTestId('command-palette-toggle-sidebar').textContent).toContain(
      'Show sidebar',
    );
  });

  test('AC5: doc-panel and terminal toggle labels reflect view-menu-state', async () => {
    setViewMenuState({ docPanelVisible: true, terminalVisible: true });
    await renderPalette({ bridge: createBridge() });
    await setQuery('document panel');
    expect(screen.getByTestId('command-palette-toggle-doc-panel').textContent).toContain(
      'Hide document panel',
    );
    await setQuery('hide terminal');
    expect(screen.getByTestId('command-palette-toggle-terminal').textContent).toContain(
      'Hide Terminal',
    );

    cleanup();
    setViewMenuState({ docPanelVisible: false, terminalVisible: false });
    await renderPalette({ bridge: createBridge() });
    await setQuery('document panel');
    expect(screen.getByTestId('command-palette-toggle-doc-panel').textContent).toContain(
      'Show document panel',
    );
    await setQuery('show terminal');
    expect(screen.getByTestId('command-palette-toggle-terminal').textContent).toContain(
      'Show Terminal',
    );
  });

  test('AC5: kill-terminal is search-visible only when a terminal is live', async () => {
    setViewMenuState({ terminalLive: true });
    await renderPalette({ bridge: createBridge() });
    await setQuery('kill terminal');
    expect(screen.queryByTestId('command-palette-kill-terminal')).not.toBeNull();

    cleanup();
    setViewMenuState({ terminalLive: false });
    await renderPalette({ bridge: createBridge() });
    await setQuery('kill terminal');
    expect(screen.queryByTestId('command-palette-kill-terminal')).toBeNull();
  });

  test('AC6: the spell-check row toggles via the bridge invoke, not view-menu-state', async () => {
    const { bridge } = await renderPalette({ bridge: createBridge() });
    await setQuery('check spelling while typing');
    fireEvent.click(screen.getByTestId('command-palette-toggle-spell-check'));
    await waitFor(() => expect(bridge?.spellcheck.toggle).toHaveBeenCalledTimes(1));
  });

  test('AC7: contextual commands gate on the active editor target', async () => {
    // Missing target → no contextual rows.
    await renderPalette({ bridge: createBridge(), docName: null });
    await setQuery('rename');
    expect(screen.queryByTestId('command-palette-rename')).toBeNull();
    await setQuery('duplicate');
    expect(screen.queryByTestId('command-palette-duplicate')).toBeNull();

    // Doc target → rename + duplicate present.
    cleanup();
    await renderPalette({ bridge: createBridge(), docName: 'docs/thing' });
    await setQuery('rename');
    expect(screen.queryByTestId('command-palette-rename')).not.toBeNull();
    await setQuery('duplicate');
    expect(screen.queryByTestId('command-palette-duplicate')).not.toBeNull();

    // Asset-like target → duplicate hidden, rename still present (target-kind projection).
    // Clear the query first so re-typing 'duplicate' is a real value change that forces
    // a re-render after the activeTarget mutation (a same-value setState would bail).
    activeTarget = { kind: 'asset', assetPath: 'img.png' };
    await setQuery('');
    await setQuery('duplicate');
    expect(screen.queryByTestId('command-palette-duplicate')).toBeNull();
    await setQuery('rename');
    expect(screen.queryByTestId('command-palette-rename')).not.toBeNull();

    // Folder target → duplicate re-enabled (the doc-OR-folder availability
    // clause), so narrowing the gate to doc-only turns this red.
    activeTarget = { kind: 'folder', folderPath: 'docs/notes' };
    await setQuery('');
    await setQuery('duplicate');
    expect(screen.queryByTestId('command-palette-duplicate')).not.toBeNull();
  });

  test('AC8: backfilled rows do not render on empty open', async () => {
    await renderPalette({ bridge: createBridge() });
    // No query typed — the backfill long-tail is search-only.
    expect(screen.queryByTestId('command-palette-rename')).toBeNull();
    expect(screen.queryByTestId('command-palette-toggle-sidebar')).toBeNull();
    expect(screen.queryByTestId('command-palette-check-for-updates')).toBeNull();
    expect(screen.queryByTestId('command-palette-new-terminal')).toBeNull();
  });
});
