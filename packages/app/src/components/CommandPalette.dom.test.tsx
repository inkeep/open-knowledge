import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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
let reportBugDialogProps: Array<{ open: boolean; launcherBorne?: boolean }> = [];
let feedbackDialogProps: Array<{ open: boolean; source?: string }> = [];
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

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{(value === 1 ? one : other).replace('#', String(value))}</>
  ),
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

vi.doMock('@/components/ui/command', () => ({
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

vi.doMock('@/components/doc-panel-events', () => ({
  requestDocPanelTab: (tab: string) => {
    requestDocPanelTabCalls.push(tab);
  },
}));

vi.doMock('@/components/NewItemDialog', () => ({
  NewItemDialog: (props: { open: boolean; kind: string; initialDir: string }) => {
    newItemDialogProps.push(props);
    return (
      <div data-kind={props.kind} data-open={String(props.open)} data-testid="new-item-dialog" />
    );
  },
}));

vi.doMock('@/components/SeedDialog', () => ({
  SeedDialog: (props: { open: boolean }) => {
    seedDialogProps.push(props);
    return <div data-open={String(props.open)} data-testid="seed-dialog" />;
  },
}));

vi.doMock('@/components/CreateProjectDialog', () => ({
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

vi.doMock('@/components/ReportBugDialog', () => ({
  ReportBugDialog: (props: { open: boolean; launcherBorne?: boolean }) => {
    reportBugDialogProps.push(props);
    return <div data-open={String(props.open)} data-testid="report-bug-dialog" />;
  },
}));

// `lazy()`-loaded in CommandPalette, so the mock must expose a `default`.
vi.doMock('@/components/BugReportHistoryDialog', () => ({
  default: (props: { open: boolean; onReportABug: () => void }) =>
    props.open ? (
      <button data-testid="history-report-cta" onClick={props.onReportABug} type="button">
        history-cta
      </button>
    ) : null,
}));

vi.doMock('@/components/FeedbackFormDialog', () => ({
  FeedbackFormDialog: (props: { open: boolean; source?: string }) => {
    feedbackDialogProps.push(props);
    return (
      <div
        data-open={String(props.open)}
        data-source={props.source}
        data-testid="feedback-form-dialog"
      />
    );
  },
}));

vi.doMock('@/components/PageListContext', () => ({
  usePageList: () => ({
    pages: new Set<string>(),
    pageTitles: new Map<string, string>(),
    pageMeta: new Map<string, unknown>(),
    folderPaths: new Set<string>(),
    filePaths: new Set<string>(),
    loading: pageListLoading,
  }),
}));

vi.doMock('@/editor/DocumentContext', () => ({
  // Whole-module replacement: CommandPalette imports useOpenBlobRunner for the
  // Blob Run row, so the export must exist here or the link detonates.
  useOpenBlobRunner: () => null,
  useDocumentContext: () => ({
    activeDocName,
    activeTarget,
  }),
}));

vi.doMock('@/lib/use-workspace', () => ({
  useWorkspace: () => workspaceValue,
}));

vi.doMock('./handoff/useInstalledAgents', () => ({
  useInstalledAgents: () => ({
    states: installedAgentStates,
    refresh: refreshInstallStates,
  }),
}));

vi.doMock('./handoff/useHandoffDispatch', () => ({
  buildHandoffInput: ({ docName, workspace }: { docName: string | null; workspace: unknown }) =>
    docName && workspace ? { docName, workspace } : null,
  useHandoffDispatch: () => ({
    dispatch: vi.fn(() => Promise.resolve()),
  }),
}));

vi.doMock('@/components/command-palette-tag-search', () => ({
  TAG_QUERY_PREFIX: 'tag:',
  parseTagPaletteQuery: () => ({ kind: 'normal' }),
  filterTagList: () => [],
  fetchTagsList: vi.fn(() => Promise.resolve([])),
  fetchDocsForTag: vi.fn(() => Promise.resolve([])),
}));

// The cached worktree model is read via useWorktrees (backed by window.okDesktop,
// not the bridge prop). Default null so the existing suite sees no Worktrees
// group; the dedicated test sets a model.
let worktreeModelMock: import('@inkeep/open-knowledge-core').WorktreeSelectorModel | null = null;
vi.doMock('@/hooks/use-worktrees', () => ({
  useWorktrees: () => worktreeModelMock,
}));
const refreshWorktreesMock = vi.fn(() => {});
vi.doMock('@/lib/worktree-store', () => ({ refreshWorktrees: refreshWorktreesMock }));

function recent(name: string, path = `/projects/${name.toLowerCase()}`) {
  return { name, path: path.replaceAll(' ', '-') };
}

function createBridge({
  ptyAvailable = true,
  terminalAvailable = true,
}: {
  ptyAvailable?: boolean;
  terminalAvailable?: boolean;
} = {}) {
  return {
    config: {
      projectName: 'Current Project',
      projectPath: '/projects/current',
      ptyAvailable,
    },
    terminal: terminalAvailable ? {} : undefined,
    project: {
      listRecent: vi.fn(() =>
        Promise.resolve([
          recent('Current', '/projects/current'),
          recent('Alpha', '/projects/alpha'),
          recent('Omega', '/archive/proj-7'),
        ]),
      ),
      open: vi.fn(() => Promise.resolve()),
      openFile: vi.fn(() => Promise.resolve()),
      removeRecent: vi.fn(() => Promise.resolve()),
    },
    dialog: {
      openFolder: vi.fn(() => Promise.resolve('/chosen/folder')),
    },
    navigator: {
      open: vi.fn(() => Promise.resolve()),
    },
    worktree: {
      create: vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          path: '/projects/current/.ok/worktrees/feature-x',
          created: true,
        }),
      ),
    },
    // Surfaces the backfilled bridge-invoke commands reach.
    update: {
      checkNow: vi.fn(() => Promise.resolve()),
    },
    mcpWiring: {
      reconfigure: vi.fn(() => Promise.resolve(true)),
    },
    spellcheck: {
      toggle: vi.fn(() => Promise.resolve(true)),
    },
    shell: {
      openExternal: vi.fn(() => Promise.resolve()),
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
  const onOpenChange = vi.fn(() => {});
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
    feedbackDialogProps = [];
    commandDialogProps = [];
    refreshInstallStatesCalls = 0;
    worktreeModelMock = null;
    refreshWorktreesMock.mockClear();
    window.location.hash = '';
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 })),
    ) as never;
  });

  test('hides active-document commands without an active doc and opens the graph panel when one exists', async () => {
    await renderPalette({ bridge: null, docName: null });

    expect(document.body.textContent).not.toContain('No active doc');
    expect(screen.queryByTestId('command-palette-open-graph')).toBeNull();
    expect(screen.queryByText('Open with AI ChatGPT Desktop')).toBeNull();

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
    expect(screen.getByTestId('command-palette-open-file').textContent).toMatch(
      /⇧⌘ O|Ctrl Shift O/,
    );

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

    // Open file delegates entirely to main (picker + ephemeral open); the
    // renderer just fires the single bridge hop.
    fireEvent.click(screen.getByTestId('command-palette-open-file'));
    await waitFor(() => expect(bridge.project.openFile).toHaveBeenCalledTimes(1));

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

  test('the per-row × prunes a recent, keeps the palette open, and does not open it', async () => {
    const bridge = createBridge();
    const { onOpenChange } = await renderPalette({ bridge });
    await waitFor(() => expect(bridge.project.listRecent).toHaveBeenCalledTimes(1));

    // The × is a sibling of the recent's option row. Clicking it must prune via
    // removeRecent and NOT fall through to the row's open onSelect (the
    // stopPropagation contract) — unlike clicking the row, which opens + closes.
    fireEvent.click(screen.getByTestId('command-palette-recent-remove-/projects/alpha'));
    await waitFor(() =>
      expect(bridge.project.removeRecent).toHaveBeenCalledWith('/projects/alpha'),
    );
    expect(bridge.project.open).not.toHaveBeenCalled();

    // Optimistic drop of that row, and the palette stays open (runWithToast, not
    // runAction) so the user can prune several in a row.
    await waitFor(() =>
      expect(screen.queryByTestId('command-palette-recent-/projects/alpha')).toBeNull(),
    );
    expect(screen.queryByTestId('command-palette-recent-/archive/proj-7')).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  test('new-folder shortcut is desktop-only while new-file shortcut is always visible', async () => {
    await renderPalette({ bridge: null });

    expect(screen.getByTestId('command-palette-new-file').textContent).toMatch(/⌘ N|Ctrl N/);
    expect(screen.getByTestId('command-palette-new-folder').textContent).not.toMatch(
      /⇧⌘ N|Ctrl Shift N/,
    );
  });

  test('report-bug row shows its chord on the desktop host', async () => {
    await renderPalette({ bridge: createBridge() });

    expect(screen.getByTestId('command-palette-report-bug').textContent).toMatch(
      /⇧⌘ D|Ctrl Shift D/,
    );
  });

  test('report-bug row is absent on the web host, so its desktop-only chord never shows there', async () => {
    await renderPalette({ bridge: null });

    expect(screen.queryByTestId('command-palette-report-bug')).toBeNull();
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
    // The palette closes on select and is still animating out as the dialog
    // opens, so its screenshot must wait for the cmdk root to unmount rather
    // than photograph the surface the user only passed through.
    expect(reportBugDialogProps.at(-1)?.launcherBorne).toBe(true);
  });

  test('the bug-report-history CTA opens the compose dialog launcher-free', async () => {
    // The negative image of the assertion above, and the branch this route
    // exists for. By the time the user clicks this button they have read a list
    // of past reports, so the palette is long gone and there is nothing to wait
    // on — waiting anyway is what cost this route its pointer marker.
    const bridge = createBridge();
    await renderPalette({ bridge });

    await setQuery('bug report history');
    fireEvent.click(screen.getByTestId('command-palette-bug-report-history'));

    const cta = await screen.findByTestId('history-report-cta');
    fireEvent.click(cta);

    await waitFor(() => {
      expect(screen.getByTestId('report-bug-dialog').getAttribute('data-open')).toBe('true');
    });
    expect(reportBugDialogProps.at(-1)?.open).toBe(true);
    expect(reportBugDialogProps.at(-1)?.launcherBorne).toBe(false);
  });

  test('send-feedback command renders on both hosts and opens FeedbackFormDialog', async () => {
    // Host-agnostic, unlike report-a-bug: the form POSTs to the hosted intake
    // route, so the row is present with no bridge.
    const web = await renderPalette({ bridge: null });

    await setQuery('feedback');
    const webRow = screen.getByTestId('command-palette-send-feedback');
    expect(webRow.textContent).toContain('Send feedback');

    fireEvent.click(webRow);

    expect(web.onOpenChange).toHaveBeenCalledWith(false);
    await waitFor(() => {
      expect(screen.getByTestId('feedback-form-dialog').getAttribute('data-open')).toBe('true');
    });
    // Attribution: the palette identifies itself so intake can tell which
    // surface the feedback came from.
    expect(feedbackDialogProps.at(-1)?.source).toBe('command_palette');

    cleanup();
    await renderPalette({ bridge: createBridge() });
    await setQuery('suggestion');
    expect(screen.getByTestId('command-palette-send-feedback')).not.toBeNull();
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

  test('CommandPalette opts out of cmdk vim bindings', async () => {
    // Pins the wiring, not the behavior: command.dom.test.tsx proves against
    // the real cmdk what vimBindings:false DOES, but nothing there observes
    // whether this component passes it. Without this assertion, deleting the
    // opt-out from CommandPalette's commandProps leaves the whole suite green
    // while Ctrl+P silently regains cmdk's select-previous on Windows/Linux.
    await renderPalette();

    expect(commandDialogProps.at(-1)?.commandProps?.vimBindings).toBe(false);
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
    const onOpenChange = vi.fn(() => {});
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
    globalThis.fetch = vi.fn((input: unknown) => {
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
    globalThis.fetch = vi.fn((input: unknown) => {
      if (input === '/api/search') {
        return Promise.resolve(
          new Response(JSON.stringify({ results: [], ready: false }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    }) as never;

    const { CommandPalette } = await import('./CommandPalette');
    const onOpenChange = vi.fn(() => {});
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
    globalThis.fetch = vi.fn((input: unknown) => {
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

  // Multi-word admission, one test per population. Each population hands the
  // shared command matcher its own label + keyword pair, so a boundary-level
  // assertion alone would not prove any of them actually routes through it.
  test('fixed command rows match multi-word queries whose terms are not adjacent', async () => {
    await renderPalette({ bridge: createBridge() });

    // "Report a bug" puts "a" between the two words the user typed, and its
    // keyword string carries them in the opposite order.
    await setQuery('report bug');
    expect(screen.getByTestId('command-palette-report-bug').textContent).toContain('Report a bug');

    // The weaker of the two orderings: this one is contiguous inside the
    // keyword string, so it holds under a contiguity rule too.
    await setQuery('bug report');
    expect(screen.queryByTestId('command-palette-report-bug')).not.toBeNull();

    // A term may land inside a longer word: "work" and "tree" are both in
    // "worktree".
    await setQuery('work tree');
    expect(screen.queryByTestId('command-palette-new-worktree')).not.toBeNull();
    expect(screen.queryByTestId('command-palette-switch-worktree')).not.toBeNull();

    // One unmatched term rejects the row, so the palette cannot degrade into
    // surfacing everything that shares any single word with the query.
    await setQuery('report zzzznomatch');
    expect(screen.queryByTestId('command-palette-report-bug')).toBeNull();
  });

  test('recent-project rows match multi-word queries spanning the name and the path', async () => {
    const { bridge } = await renderPalette();
    await waitFor(() => expect(bridge?.project.listRecent).toHaveBeenCalledTimes(1));

    // The row's searchable text spans two fields: "omega" appears only in the
    // name and "archive" only in the path, so neither field satisfies the query
    // alone.
    await setQuery('omega archive');
    expect(screen.queryByTestId('command-palette-recent-/archive/proj-7')).not.toBeNull();
    expect(screen.queryByTestId('command-palette-recent-/projects/alpha')).toBeNull();
  });

  test('worktree-branch rows match multi-word queries spanning the branch and its keywords', async () => {
    worktreeModelMock = {
      mainRoot: '/projects/current',
      currentBranch: 'main',
      entries: [
        {
          branch: 'dev',
          worktreePath: '/projects/current/.ok/worktrees/dev',
          isCurrent: false,
          isMain: false,
          locked: false,
        },
        {
          branch: 'feature-x',
          worktreePath: null,
          isCurrent: false,
          isMain: false,
          locked: false,
        },
      ],
    };
    await renderPalette();

    // "branch" comes from the row's keywords, "feature" from the branch name.
    await setQuery('branch feature');
    expect(screen.queryByTestId('command-palette-worktree-feature-x')).not.toBeNull();
    // The dev row shares "branch" but not "feature", so it stays out.
    expect(screen.queryByTestId('command-palette-worktree-dev')).toBeNull();
  });

  test('open-with-AI rows match multi-word queries spanning the label and its keywords', async () => {
    await renderPalette({ bridge: createBridge() });

    // "open" heads the label and recurs in the "open in" keyword; "cursor" sits
    // in the middle of the label, so the pair is never contiguous in order.
    await setQuery('open cursor');
    expect(screen.queryByTestId('command-palette-open-in-cursor')).not.toBeNull();
    // Every other target lacks "cursor" and so stays out on "open" alone.
    expect(screen.queryByTestId('command-palette-open-in-claude-code')).toBeNull();
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
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 })),
    ) as never;
    // Panels visible + a live terminal so the state-aware View toggles render
    // their "Hide …" variant and Kill Terminal is enabled.
    setViewMenuState({
      sidebarVisible: true,
      docPanelVisible: true,
      terminalVisible: true,
      terminalPlacement: 'bottom',
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
    { testid: 'command-palette-navigate-back', query: 'back', id: 'navigate-back' },
    { testid: 'command-palette-navigate-forward', query: 'forward', id: 'navigate-forward' },
    {
      testid: 'command-palette-new-from-template',
      query: 'new from template',
      id: 'new-from-template',
    },
    { testid: 'command-palette-toggle-sidebar', query: 'sidebar', id: 'toggle-sidebar' },
    { testid: 'command-palette-toggle-doc-panel', query: 'document panel', id: 'toggle-doc-panel' },
    { testid: 'command-palette-toggle-terminal', query: 'hide terminal', id: 'toggle-terminal' },
    { testid: 'command-palette-move-terminal', query: 'move terminal', id: 'move-terminal' },
    {
      testid: 'command-palette-toggle-agent-panel',
      query: 'agents',
      id: 'toggle-agent-panel',
    },
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

  test('navigation-history rows expose their native platform shortcuts on desktop', async () => {
    await renderPalette({ bridge: createBridge() });

    await setQuery('back');
    expect(screen.getByTestId('command-palette-navigate-back').textContent).toMatch(/⌘ \[|Alt ←/);

    await setQuery('forward');
    expect(screen.getByTestId('command-palette-navigate-forward').textContent).toMatch(
      /⌘ \]|Alt →/,
    );
  });

  // Ratchet C completeness: every id classified as a palette command (shared with
  // the id-classification ratchet via command-menu-parity.test-helper) must be
  // covered by a rendered id-backed row above OR a pre-existing palette surface.
  // A future id classified into PALETTE_COMMAND_IDS with no rendered row — which
  // satisfies only Ratchets A/B — turns this red, closing the "classified but
  // unreachable" gap that the id ratchets alone cannot see.
  test('Ratchet C: every classified palette-command id renders a row or is a pre-existing surface', async () => {
    // Imported dynamically: the helper pulls in the command registry, and a
    // static import would evaluate the registry before the `vi.doMock`
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
    const openSpy = vi.fn(() => null);
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
    const openSpy = vi.fn(() => null);
    const ambientOpenExternal = vi.fn(() => Promise.resolve());
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
    await setQuery('back');
    expect(screen.queryByTestId('command-palette-navigate-back')).toBeNull();
    await setQuery('forward');
    expect(screen.queryByTestId('command-palette-navigate-forward')).toBeNull();
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

  test('terminal placement label and action invert with the current home', async () => {
    setViewMenuState({ terminalPlacement: 'bottom' });
    await renderPalette({ bridge: createBridge() });
    await setQuery('move terminal');
    const moveRight = screen.getByTestId('command-palette-move-terminal');
    expect(moveRight.textContent).toContain('Move Terminal to right');
    fireEvent.click(moveRight);
    expect(busActions).toContain('move-terminal');

    cleanup();
    setViewMenuState({ terminalPlacement: 'right' });
    await renderPalette({ bridge: createBridge() });
    await setQuery('move terminal');
    expect(screen.getByTestId('command-palette-move-terminal').textContent).toContain(
      'Move Terminal to bottom',
    );
  });

  test('AC5: the Terminal toggle stays reachable by its established queries', async () => {
    setViewMenuState({ terminalVisible: false });
    await renderPalette({ bridge: createBridge() });
    for (const query of [
      'terminal',
      'show terminal',
      'hide terminal',
      'toggle terminal',
      'bottom dock',
      'toggle bottom dock',
      'shell',
    ]) {
      await setQuery(query);
      expect(
        screen.queryByTestId('command-palette-toggle-terminal'),
        `query "${query}" should surface the Terminal toggle`,
      ).not.toBeNull();
    }
  });

  test('off-mac and incomplete desktop bridges hide every PTY-backed palette command', async () => {
    const terminalCommands = [
      ['show terminal', 'toggle-terminal'],
      ['new terminal', 'new-terminal'],
      ['move terminal', 'move-terminal'],
      ['kill terminal', 'kill-terminal'],
    ] as const;

    setViewMenuState({ terminalLive: true });
    await renderPalette({ bridge: createBridge({ ptyAvailable: false }) });
    for (const [query, id] of terminalCommands) {
      await setQuery(query);
      expect(screen.queryByTestId(`command-palette-${id}`)).toBeNull();
    }

    cleanup();
    await renderPalette({ bridge: createBridge({ terminalAvailable: false }) });
    for (const [query, id] of terminalCommands) {
      await setQuery(query);
      expect(screen.queryByTestId(`command-palette-${id}`)).toBeNull();
    }
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

  test('"close terminal" puts the reversible row ahead of the destructive one', async () => {
    // Kill Terminal ends a live shell with no confirmation and no undo, and it
    // answers to "close" as much as Hide Terminal does. Nothing stops both from
    // matching; what keeps the safe one preselected is that it sits in the view
    // group, which renders before the terminal group. With no filtering of its
    // own, the palette highlights whichever row comes first in the document, so
    // that group ordering is the whole safety property and it is invisible from
    // the keyword data alone.
    setViewMenuState({ terminalLive: true });
    await renderPalette({ bridge: createBridge() });
    await setQuery('close terminal');

    const reversible = screen.getByTestId('command-palette-toggle-terminal');
    const destructive = screen.getByTestId('command-palette-kill-terminal');

    const reversibleComesFirst =
      reversible.compareDocumentPosition(destructive) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(reversibleComesFirst).toBeTruthy();
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

/**
 * ⌘K is a toggle, so its gate is asymmetric: any other open layer owns the
 * keyboard and must keep the palette from stacking on top of it, but once the
 * palette is up it IS the top layer and ⌘K has to keep dismissing it.
 */
describe('CommandPalette ⌘K — overlay gate', () => {
  beforeEach(() => {
    cleanup();
    activeDocName = 'docs/active';
    activeTarget = { kind: 'doc', docName: 'docs/active' };
    pageListLoading = false;
    commandDialogProps = [];
    window.location.hash = '';
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 })),
    ) as never;
  });

  function pressCommandK() {
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
  }

  // Both platform variants; the registry matcher is platform-aware, so exactly
  // one of the two is the live chord on any given run.
  function pressCommandP() {
    fireEvent.keyDown(document.body, { key: 'p', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'p', ctrlKey: true });
  }

  test('closes itself on ⌘K while it is the open layer', async () => {
    const { onOpenChange } = await renderPalette({ bridge: createBridge() });

    pressCommandK();

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('does not open on ⌘K while another dialog owns the keyboard', async () => {
    const { Dialog, DialogContent, DialogDescription, DialogTitle } = await import(
      '@/components/ui/dialog'
    );
    const { CommandPalette } = await import('./CommandPalette');
    const onOpenChange = vi.fn(() => {});
    render(
      <>
        <CommandPalette bridge={createBridge() as never} open={false} onOpenChange={onOpenChange} />
        <Dialog open>
          <DialogContent>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>Settings body</DialogDescription>
          </DialogContent>
        </Dialog>
      </>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).not.toBeNull());

    pressCommandK();

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test('opens on ⌘K with nothing else open', async () => {
    const { CommandPalette } = await import('./CommandPalette');
    const onOpenChange = vi.fn(() => {});
    render(
      <CommandPalette bridge={createBridge() as never} open={false} onOpenChange={onOpenChange} />,
    );

    pressCommandK();

    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  // The ⌘P happy paths, symmetric with the ⌘K pair above. The registry unit
  // tests cover the matcher in isolation; these cover the chord actually
  // reaching this component's window listener and driving onOpenChange —
  // which is the behavior the feature is named for.
  test('opens on ⌘P with nothing else open', async () => {
    const { CommandPalette } = await import('./CommandPalette');
    const onOpenChange = vi.fn(() => {});
    render(
      <CommandPalette bridge={createBridge() as never} open={false} onOpenChange={onOpenChange} />,
    );

    pressCommandP();

    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  test('closes itself on ⌘P while it is the open layer', async () => {
    const { onOpenChange } = await renderPalette({ bridge: createBridge() });

    pressCommandP();

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('suppresses the browser default on the palette chord even when another dialog owns the keyboard', async () => {
    // ⌘P / Ctrl+P matches the palette opener AND is the browser's Print
    // accelerator on the web host. When another layer owns the keyboard the
    // palette declines to open — but it must still preventDefault, or the
    // browser Print dialog leaks in exactly that state (e.g. Settings open).
    // Regression guard for the preventDefault-before-decline ordering.
    const { Dialog, DialogContent, DialogDescription, DialogTitle } = await import(
      '@/components/ui/dialog'
    );
    const { CommandPalette } = await import('./CommandPalette');
    const onOpenChange = vi.fn(() => {});
    render(
      <>
        <CommandPalette bridge={createBridge() as never} open={false} onOpenChange={onOpenChange} />
        <Dialog open>
          <DialogContent>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>Settings body</DialogDescription>
          </DialogContent>
        </Dialog>
      </>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).not.toBeNull());

    // Fire both platform variants; exactly one matches the detected platform
    // (⌘P on mac, Ctrl+P on Windows/Linux) and that one must be suppressed.
    const cmdP = new KeyboardEvent('keydown', {
      key: 'p',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    const ctrlP = new KeyboardEvent('keydown', {
      key: 'p',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(document.body, cmdP);
    fireEvent(document.body, ctrlP);

    expect(cmdP.defaultPrevented || ctrlP.defaultPrevented).toBe(true);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
