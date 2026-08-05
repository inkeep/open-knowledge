import { MarkdownManager, sharedExtensions, stripFrontmatter } from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Editor, getSchema, isMacOS } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { registerEditor, unregisterEditor } from '@/editor/active-editor';
import { publishSelectionContext } from '@/editor/selection-context';
import type { EditorSurface } from '@/editor/selection-stats';
import {
  clearPendingSourceNavigationsForTest,
  peekPendingSourceNavigation,
} from '@/editor/source-editor-navigation';
import { VIEW_IN_SOURCE_EVENT, type ViewInSourceDetail } from '@/editor/view-in-source-event';
import { subscribeToPreferredSessionRequests } from './handoff/preferred-session-events';
import { subscribeToActiveTerminalInput } from './handoff/terminal-input-events';
import { requestAgentThreadLaunch } from './handoff/thread-launch-events';

// The doc the mocked DocumentContext reports (see the useDocumentContext mock).
const TEST_DOC = 'docs/notes';

// Seed / clear the shared selection snapshot registry EditorPane reads for the
// ⌘J / ⇧⌘J selection-paste path. Seed both body surfaces so the test is
// independent of the default editor mode.
function seedSelection(markdown: string): void {
  for (const surface of ['wysiwyg', 'source'] as EditorSurface[]) {
    publishSelectionContext(TEST_DOC, surface, {
      surface,
      docName: TEST_DOC,
      markdown,
      charLen: markdown.length,
      lineCount: 1,
    });
  }
}
function clearSelection(): void {
  publishSelectionContext(TEST_DOC, 'wysiwyg', null);
  publishSelectionContext(TEST_DOC, 'source', null);
}

// Substrate for the view-in-source seam test: a stand-in editor whose mounted PM
// view carries the caret + doc, so the real jump reads the block under the caret.
const jumpMd = new MarkdownManager({ extensions: sharedExtensions });
const jumpSchema = getSchema(sharedExtensions);

/** PM position just inside top-level block `index`. */
function pmPosOfBlock(doc: PmNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos + 1;
}

function makeJumpEditor(markdown: string, caretBlock: number): Editor {
  const { body } = stripFrontmatter(markdown);
  const doc = jumpSchema.nodeFromJSON(jumpMd.parse(body));
  return {
    isDestroyed: false,
    editorView: { state: { doc, selection: { from: pmPosOfBlock(doc, caretBlock) } } },
  } as unknown as Editor;
}

// Collect the Ask-AI passages EditorPane dispatches to the sessions host (which
// owns reuse-vs-launch and preferred-AI resolution; mocked here). `newTab` rides
// along so ⌘J (reuse when sensible) stays distinguishable from ⇧⌘J (always fresh).
function captureActiveTerminalInput(): {
  texts: string[];
  details: { text: string; newTab: boolean; submit: boolean }[];
  stop: () => void;
} {
  const texts: string[] = [];
  const details: { text: string; newTab: boolean; submit: boolean }[] = [];
  const stop = subscribeToActiveTerminalInput((detail) => {
    texts.push(detail.text);
    details.push({ text: detail.text, newTab: detail.newTab, submit: detail.submit });
  });
  return { texts, details, stop };
}

// Count the promptless "open my preferred AI" requests EditorPane dispatches
// (⇧⌘J with no selection). The host resolves which AI that is.
function capturePreferredSessionRequests(): { readonly count: number; stop: () => void } {
  const state = { count: 0, stop: () => {} };
  const unsubscribe = subscribeToPreferredSessionRequests(() => {
    state.count += 1;
  });
  state.stop = unsubscribe;
  return state;
}

function shiftJKeydownInit(): KeyboardEventInit {
  const init: KeyboardEventInit = { key: 'j', shiftKey: true, cancelable: true, bubbles: true };
  if (isMacOS()) init.metaKey = true;
  else init.ctrlKey = true;
  return init;
}

import * as actualLinguiMacro from '@lingui/react/macro';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) => (
    <>{(value === 1 ? one : other).replace('#', String(value))}</>
  ),
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ''}`, ''),
  }),
}));

let hasRemote = false;
let projectLocalSynced = false;
let projectSynced = false;
let projectLocalConfig: { autoSync?: { enabled?: boolean | null } } | null = null;
let projectConfig: { autoSync?: { default?: boolean | null } } | null = null;
let pushPermissionCheckStatus: 'allowed' | 'denied' | 'unknown' | undefined = 'allowed';

vi.doMock('@/hooks/use-git-sync-status', () => ({
  useGitSyncStatus: () => ({
    hasRemote,
    pushPermission: { checkStatus: pushPermissionCheckStatus },
  }),
}));

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    projectConfig,
    projectLocalConfig,
    projectLocalSynced,
    projectSynced,
  }),
}));

vi.doMock('@/lib/use-workspace', () => ({
  useWorkspace: () => ({ contentDir: '/tmp/project', pathSeparator: '/' }),
}));

// Mutable so the view-in-source test can supply a provider — its source Y.Text
// is what the jump reads. Default undefined keeps every other test unchanged
// (EditorPane's view-in-source path early-returns without a provider).
let activeProvider: { document: Y.Doc } | undefined;
vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: 'docs/notes',
    collabUrl: 'ws://test',
    activeProvider,
  }),
  // EditorArea imports isSkillsNewTabId; keep it in the partial mock so the
  // module link can't detonate on load-order (see mock-module-completeness).
  isSkillsNewTabId: () => false,
}));

vi.doMock('@/editor/use-editor-mode', () => ({
  useEditorMode: () => ['wysiwyg', () => {}],
}));

vi.doMock('./EditorHeader', () => ({
  EditorHeader: ({ children }: { children?: ReactNode }) => (
    <div data-testid="editor-header">{children}</div>
  ),
}));

// EditorArea renders the layout shells + reports both panels' placements up; the
// live session hosts live in EditorPane as siblings of EditorArea (so a view-kind
// change can't remount them). EditorPane still owns the open/⌘J/⌘L/menu/telemetry
// state. The EditorArea mock is a bare stand-in; the SessionsHost mock (below)
// surfaces the threaded `surface` + `visible` + `launch` props so these tests keep
// asserting EditorPane's wiring across the prop boundary.
vi.doMock('./EditorArea', () => ({
  EditorArea: ({
    renderWorkspaceHeader,
  }: {
    renderWorkspaceHeader?: (tabs: ReactNode) => ReactNode;
  }) => (
    <div data-testid="editor-area">
      {renderWorkspaceHeader?.(<div data-testid="workspace-tabs" />)}
    </div>
  ),
}));
// The agent-thread client binder opens a WS + polls /api/config on mount; stub it
// so these EditorPane tests exercise terminal/onboarding wiring in isolation.
vi.doMock('./acp/AgentThreadClientBinder', () => ({
  AgentThreadClientBinder: () => null,
}));
// EditorPane mounts the host twice — the agents panel unconditionally (agent
// threads are server-hosted, so it works on web) and the terminal dock only where
// a shell can spawn. One mock serves both; the testid is keyed by `surface` so a
// test can assert on the panel it means. `data-terminal-capable` pins the GLOBAL
// capability fact both hosts need for the Ask-AI arbitration.
vi.doMock('./SessionsHost', () => ({
  SessionsHost: ({
    surface,
    bridge,
    terminalCapable,
    visible,
    launch,
    threadLaunch,
  }: {
    surface: string;
    bridge?: unknown;
    terminalCapable?: boolean;
    visible?: boolean;
    launch?: { nonce: number; stagePaste?: string } | null;
    threadLaunch?: { nonce: number; agentId?: string; prompt?: string | null } | null;
  }) => {
    return (
      <div
        data-testid={surface === 'agents-panel' ? 'agents-panel' : 'terminal-dock'}
        data-has-bridge={String(bridge != null)}
        data-terminal-capable={String(terminalCapable === true)}
        data-visible={String(visible)}
        data-launch-nonce={launch ? String(launch.nonce) : 'none'}
        data-launch-stage={launch?.stagePaste ?? 'none'}
        data-thread-launch-nonce={threadLaunch ? String(threadLaunch.nonce) : 'none'}
        data-thread-launch-agent={threadLaunch?.agentId ?? 'none'}
      />
    );
  },
}));

const terminalOpenedCalls: true[] = [];
vi.doMock('@/lib/terminal-telemetry', () => ({
  recordTerminalOpened: () => terminalOpenedCalls.push(true),
  recordShellConsentGranted: () => undefined,
}));

vi.doMock('./AuthModal', () => ({
  AuthModal: () => <div data-testid="auth-modal" />,
}));

vi.doMock('@/editor/components/TagDialog', () => ({
  TagDialog: () => <div data-testid="tag-dialog" />,
}));

vi.doMock('./AutoSyncOnboardingDialog', () => ({
  AutoSyncOnboardingDialog: ({
    open,
    variant,
    onResolved,
  }: {
    open: boolean;
    variant: string;
    onResolved: () => void;
  }) => (
    <button
      type="button"
      data-testid="auto-sync-onboarding"
      data-open={String(open)}
      data-variant={variant}
      onClick={onResolved}
    >
      Auto sync onboarding
    </button>
  ),
}));

async function renderEditorPane() {
  const { EditorPane } = await import('./EditorPane');
  render(<EditorPane />);
  // Flush the mount-time async dock-state restore (getDockState) and the
  // re-render it triggers, so the now-gated View-menu push settles
  // deterministically before assertions read viewMenuPushes / data-visible.
  await act(async () => {});
}

describe('EditorPane auto-sync onboarding gate', () => {
  afterEach(() => {
    cleanup();
    hasRemote = false;
    projectLocalSynced = false;
    projectSynced = false;
    projectLocalConfig = null;
    projectConfig = null;
    pushPermissionCheckStatus = 'allowed';
  });

  test('exports the EditorPane component', async () => {
    const mod = await import('./EditorPane');
    expect(typeof mod.EditorPane).toBe('function');
  });

  test('opens when remote exists, both configs synced, enabled is null, and no committed default', async () => {
    hasRemote = true;
    projectSynced = true;
    projectLocalSynced = true;
    projectLocalConfig = { autoSync: { enabled: null } };
    projectConfig = { autoSync: { default: null } };

    await renderEditorPane();

    expect(screen.getByTestId('auto-sync-onboarding').getAttribute('data-open')).toBe('true');
  });

  test('opens when autoSync carries neither a mode nor a legacy enabled value', async () => {
    hasRemote = true;
    projectSynced = true;
    projectLocalSynced = true;
    // Neither key set → the resolved local mode is null (unanswered), so the
    // prompt fires — the mode resolver treats absent the same as the null
    // sentinel, unlike the old literal `enabled === null` check.
    projectLocalConfig = { autoSync: {} };
    projectConfig = { autoSync: { default: null } };

    await renderEditorPane();

    expect(screen.getByTestId('auto-sync-onboarding').getAttribute('data-open')).toBe('true');
  });

  test.each([
    // label, hasRemote, projectSynced, projectLocalSynced, projectLocalConfig, projectConfig
    [
      'no remote',
      false,
      true,
      true,
      { autoSync: { enabled: null } },
      { autoSync: { default: null } },
    ],
    [
      'committed config not synced',
      true,
      false,
      true,
      { autoSync: { enabled: null } },
      { autoSync: { default: null } },
    ],
    [
      'project-local config not synced',
      true,
      true,
      false,
      { autoSync: { enabled: null } },
      { autoSync: { default: null } },
    ],
    ['project-local config missing', true, true, true, null, { autoSync: { default: null } }],
    [
      'enabled true already answered',
      true,
      true,
      true,
      { autoSync: { enabled: true } },
      { autoSync: { default: null } },
    ],
    [
      'enabled false already answered',
      true,
      true,
      true,
      { autoSync: { enabled: false } },
      { autoSync: { default: null } },
    ],
    [
      'committed default off suppresses the prompt',
      true,
      true,
      true,
      { autoSync: { enabled: null } },
      { autoSync: { default: false } },
    ],
    [
      'committed default on suppresses the prompt',
      true,
      true,
      true,
      { autoSync: { enabled: null } },
      { autoSync: { default: true } },
    ],
  ] as const)('stays closed when %s', async (_label, nextHasRemote, nextProjectSynced, nextSynced, nextProjectLocalConfig, nextProjectConfig) => {
    hasRemote = nextHasRemote;
    projectSynced = nextProjectSynced;
    projectLocalSynced = nextSynced;
    projectLocalConfig = nextProjectLocalConfig;
    projectConfig = nextProjectConfig;

    await renderEditorPane();

    expect(screen.getByTestId('auto-sync-onboarding').getAttribute('data-open')).toBe('false');
  });

  test('a denied push probe opens the pull-only variant', async () => {
    hasRemote = true;
    projectSynced = true;
    projectLocalSynced = true;
    projectLocalConfig = { autoSync: { enabled: null } };
    projectConfig = { autoSync: { default: null } };
    pushPermissionCheckStatus = 'denied';

    await renderEditorPane();

    const dialog = screen.getByTestId('auto-sync-onboarding');
    expect(dialog.getAttribute('data-open')).toBe('true');
    expect(dialog.getAttribute('data-variant')).toBe('follow');
  });

  test('an unknown push probe keeps the prompt closed', async () => {
    hasRemote = true;
    projectSynced = true;
    projectLocalSynced = true;
    projectLocalConfig = { autoSync: { enabled: null } };
    projectConfig = { autoSync: { default: null } };
    pushPermissionCheckStatus = 'unknown';

    await renderEditorPane();

    expect(screen.getByTestId('auto-sync-onboarding').getAttribute('data-open')).toBe('false');
  });

  test('resolved onboarding dismisses the dialog in the same render path', async () => {
    hasRemote = true;
    projectSynced = true;
    projectLocalSynced = true;
    projectLocalConfig = { autoSync: { enabled: null } };
    projectConfig = { autoSync: { default: null } };
    await renderEditorPane();

    const dialog = screen.getByTestId('auto-sync-onboarding');
    expect(dialog.getAttribute('data-open')).toBe('true');

    await userEvent.click(dialog);

    expect(screen.getByTestId('auto-sync-onboarding').getAttribute('data-open')).toBe('false');
  });
});

// Minimal faithful stand-in for the desktop bridge surfaces EditorPane's
// terminal wiring touches: `onMenuAction` (subscribe), the View-menu-state push,
// `terminal.getDockState` (read once on mount to restore BOTH panels' visibility
// after a reload), and `terminal.cliInstalledMap` (read once on mount for the
// New-chat default CLI). The real `window.okDesktop` always exposes these, so an
// empty `{}` stub would no longer model the boundary now that EditorPane calls
// them on mount. getDockState resolves both panels hidden so the restore is a
// no-op — these tests exercise the start-hidden toggle/launch behavior.
type DockStateResult = { terminalVisible: boolean; agentPanelVisible: boolean };
function makeOkDesktopStub(
  getDockState: () => Promise<DockStateResult> = async () => ({
    terminalVisible: false,
    agentPanelVisible: false,
  }),
) {
  const menuHandlers: Array<(action: string) => void> = [];
  const viewMenuPushes: Array<{
    terminalVisible?: boolean;
    agentPanelVisible?: boolean;
    canViewInSource?: boolean;
  }> = [];
  return {
    viewMenuPushes,
    dispatchMenuAction(action: string) {
      for (const cb of menuHandlers) cb(action);
    },
    stub: {
      // The terminal affordances gate on the host's pty capability
      // (`config.ptyAvailable`, false on win/linux where node-pty isn't
      // bundled) — these tests model the capable macOS host.
      config: { ptyAvailable: true },
      onMenuAction(cb: (action: string) => void) {
        menuHandlers.push(cb);
        return () => {
          const index = menuHandlers.indexOf(cb);
          if (index >= 0) menuHandlers.splice(index, 1);
        };
      },
      editor: {
        notifyViewMenuStateChanged(state: {
          terminalVisible?: boolean;
          agentPanelVisible?: boolean;
          canViewInSource?: boolean;
        }) {
          viewMenuPushes.push(state);
        },
      },
      terminal: {
        getDockState,
        cliInstalledMap: async () => ({
          claude: true,
          codex: false,
          opencode: false,
          cursor: false,
        }),
      },
    },
  };
}

describe('EditorPane session-panel wiring', () => {
  afterEach(() => {
    cleanup();
    delete (window as { okDesktop?: unknown }).okDesktop;
    terminalOpenedCalls.length = 0;
    clearSelection();
    activeProvider = undefined;
    clearPendingSourceNavigationsForTest();
  });

  test('web host mounts the agents panel only — no shell can spawn, so no terminal dock', async () => {
    await renderEditorPane();

    // Agent threads are server-hosted, so the agents panel is universal. The
    // terminal dock is NOT mounted where no PTY can spawn: an empty dock there
    // would be a control that can never do anything.
    const agents = screen.getByTestId('agents-panel');
    expect(agents.getAttribute('data-has-bridge')).toBe('false');
    expect(agents.getAttribute('data-terminal-capable')).toBe('false');
    expect(screen.queryByTestId('terminal-dock')).toBeNull();
    expect(screen.getByTestId('editor-header')).toBeTruthy();
    expect(screen.getByTestId('editor-header').contains(screen.getByTestId('workspace-tabs'))).toBe(
      true,
    );
    expect(screen.getByTestId('editor-area')).toBeTruthy();
  });

  test('desktop host mounts BOTH panels as siblings of the editor area', async () => {
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub().stub;
    await renderEditorPane();

    // Both hosts live in EditorPane (above EditorArea) so a view-kind change
    // can't remount them, and both get the live bridge + the same global
    // terminal-capability fact the Ask-AI arbitration resolves against.
    expect(screen.getByTestId('editor-header')).toBeTruthy();
    expect(screen.getByTestId('editor-area')).toBeTruthy();
    for (const testid of ['terminal-dock', 'agents-panel']) {
      const panel = screen.getByTestId(testid);
      expect(panel.getAttribute('data-has-bridge')).toBe('true');
      expect(panel.getAttribute('data-terminal-capable')).toBe('true');
    }
  });

  test('desktop: the two panels open and close independently', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    const terminal = () => screen.getByTestId('terminal-dock').getAttribute('data-visible');
    const agents = () => screen.getByTestId('agents-panel').getAttribute('data-visible');
    expect(terminal()).toBe('false');
    expect(agents()).toBe('false');

    // ⌘L opens the agents panel and leaves the terminal alone.
    act(() => desk.dispatchMenuAction('toggle-agent-panel'));
    expect(agents()).toBe('true');
    expect(terminal()).toBe('false');

    // ⌘J then opens the terminal — both are up at once, the whole point of the
    // split. Toggling one must never close the other.
    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(agents()).toBe('true');
    expect(terminal()).toBe('true');

    act(() => desk.dispatchMenuAction('toggle-agent-panel'));
    expect(agents()).toBe('false');
    expect(terminal()).toBe('true');
  });

  test('desktop: each panel pushes its own view-menu field, never the other', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    act(() => desk.dispatchMenuAction('toggle-agent-panel'));

    // The agents push carries agentPanelVisible ONLY — main merges partials, so a
    // push that also carried terminalVisible would clobber the terminal's
    // retained per-window state on every ⌘L.
    const agentsPush = desk.viewMenuPushes.at(-1);
    expect(agentsPush).toEqual({ agentPanelVisible: true });
  });

  test('desktop: toggle-terminal flips terminal visibility and pushes the view-menu state', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
    // Mount pushes terminalVisible:false so the View menu reads "Show Bottom Dock".
    // Both panels push on mount, so name the field rather than taking the last.
    expect(desk.viewMenuPushes).toContainEqual({ terminalVisible: false });

    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('true');
    expect(desk.viewMenuPushes.at(-1)).toEqual({ terminalVisible: true });

    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
    expect(desk.viewMenuPushes.at(-1)).toEqual({ terminalVisible: false });
  });

  test('desktop: hiding the terminal clears the launch intent so a reopen is blank (regression)', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    const { requestTerminalLaunch } = await import('./handoff/terminal-launch-events');
    await renderEditorPane();

    const dock = () => screen.getByTestId('terminal-dock');
    expect(dock().getAttribute('data-launch-nonce')).toBe('none');

    // "Open in terminal" opens the dock and carries a one-shot launch intent.
    act(() => requestTerminalLaunch('work on docs/notes', 'claude'));
    expect(dock().getAttribute('data-visible')).toBe('true');
    expect(dock().getAttribute('data-launch-nonce')).toBe('1');

    // Hiding clears the spent intent. A kill drops the dock's mount latch and
    // destroys the session's once-per-nonce guard; both kill and the ⌘J toggle
    // hide via onVisibleChange(false). Without clearing here, the next fresh
    // mount would replay the old prompt instead of opening blank.
    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(dock().getAttribute('data-visible')).toBe('false');
    expect(dock().getAttribute('data-launch-nonce')).toBe('none');

    // Reopening (New Terminal) is blank — no stale launch intent re-applied.
    act(() => desk.dispatchMenuAction('new-terminal'));
    expect(dock().getAttribute('data-visible')).toBe('true');
    expect(dock().getAttribute('data-launch-nonce')).toBe('none');
  });

  test('desktop: a distinct Open-in-terminal after a hide gets a fresh, monotonic nonce', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    const { requestTerminalLaunch } = await import('./handoff/terminal-launch-events');
    await renderEditorPane();

    const dock = () => screen.getByTestId('terminal-dock');

    act(() => requestTerminalLaunch('first', 'claude'));
    expect(dock().getAttribute('data-launch-nonce')).toBe('1');

    // Hide clears the spent intent.
    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(dock().getAttribute('data-launch-nonce')).toBe('none');

    // The second, distinct click must NOT reuse nonce 1. The nonce is drawn
    // from a monotonic source rather than the previous intent's value — if it
    // restarted at 1 after the hide-clear, the dock's per-nonce dedup would see
    // a repeat of the already-opened tab and drop it, opening no new tab.
    act(() => requestTerminalLaunch('second', 'codex'));
    expect(dock().getAttribute('data-launch-nonce')).toBe('2');
  });

  test('desktop: new-terminal menu action opens the dock and stays open on repeat (not a toggle)', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');

    act(() => desk.dispatchMenuAction('new-terminal'));
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('true');

    // Idempotent open: a second New Terminal keeps it open. The View toggle
    // would have hidden it here — that is the behavioral split between them.
    act(() => desk.dispatchMenuAction('new-terminal'));
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('true');
  });

  test('desktop: an unrelated menu action does not toggle the terminal', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    act(() => desk.dispatchMenuAction('toggle-doc-panel'));
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
  });

  test('desktop: the toggle-source menu action runs the view-in-source jump', async () => {
    // The Desktop editor context menu dispatches `toggle-source` over the same
    // menu-action channel the terminal actions use. This exercises the real
    // renderer half of that seam end to end: bridge → menu-action bus →
    // EditorPane subscriber → the real view-in-source jump.
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;

    // The jump reads the caret block off the registered editor and the source
    // bytes off the active provider's Y.Text.
    const markdown = '# Title\n\nfirst paragraph\n\ntarget paragraph';
    const ydoc = new Y.Doc();
    ydoc.getText('source').insert(0, markdown);
    activeProvider = { document: ydoc };
    const editor = makeJumpEditor(markdown, 3); // caret inside "target paragraph"
    registerEditor('docs/notes', editor);

    const flips: string[] = [];
    const onFlip = (e: Event) => flips.push((e as CustomEvent<ViewInSourceDetail>).detail.docName);
    window.addEventListener(VIEW_IN_SOURCE_EVENT, onFlip);

    await renderEditorPane();
    act(() => desk.dispatchMenuAction('toggle-source'));

    window.removeEventListener(VIEW_IN_SOURCE_EVENT, onFlip);
    unregisterEditor('docs/notes', editor);

    // It requested the flip for this doc and banked a jump navigation — the
    // Desktop menu action reached the jump, not just the mode flip.
    expect(flips).toEqual(['docs/notes']);
    const nav = peekPendingSourceNavigation('docs/notes');
    if (nav?.kind !== 'selection-offset') throw new Error('expected a selection-offset nav');
    expect(nav.intent).toBe('jump');
  });

  // Main attaches the native context menu to every editable field in the window
  // and cannot tell which surface fired it, so whether the "View in Source" row
  // is offered rides entirely on this push. If it stopped happening, the row
  // would silently vanish from the desktop editor instead of appearing where it
  // does not belong.
  test('desktop: pushes the view-in-source capability for the context-menu row', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;

    // No provider: nothing for the jump to read, so the row must stay out.
    await renderEditorPane();
    expect(desk.viewMenuPushes).toContainEqual({ canViewInSource: false });
    expect(desk.viewMenuPushes).not.toContainEqual({ canViewInSource: true });

    cleanup();
    const ydoc = new Y.Doc();
    ydoc.getText('source').insert(0, '# Title\n\nbody');
    activeProvider = { document: ydoc };
    const live = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = live.stub;

    await renderEditorPane();
    expect(live.viewMenuPushes).toContainEqual({ canViewInSource: true });
  });

  test('desktop: each open records terminal-opened; mount (hidden) and close do not', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    // Starts hidden — the mount run of the effect must not record an open.
    expect(terminalOpenedCalls).toHaveLength(0);

    act(() => desk.dispatchMenuAction('toggle-terminal')); // hidden → open
    expect(terminalOpenedCalls).toHaveLength(1);

    act(() => desk.dispatchMenuAction('toggle-terminal')); // open → hidden (no record)
    expect(terminalOpenedCalls).toHaveLength(1);

    act(() => desk.dispatchMenuAction('toggle-terminal')); // hidden → open again
    expect(terminalOpenedCalls).toHaveLength(2);
  });

  test('desktop: a reload re-expands a dock that was open before it (retained visibility is not clobbered)', async () => {
    // Model main's per-window dock-visibility map at the boundary the hardcoded
    // `visible: false` stub can't: the renderer's view-menu push WRITES it,
    // getDockState READS it back. It starts `true` — the dock was open before
    // this reload. The bug is an ordering race between the two channels: the
    // mount-initial `false` push must not land in the shared map before the
    // restore reads it, or the read returns false and the dock comes back
    // collapsed (the whole feature dead).
    let retainedDockVisible = true;
    (window as { okDesktop?: unknown }).okDesktop = {
      config: { ptyAvailable: true },
      onMenuAction: () => () => {},
      editor: {
        notifyViewMenuStateChanged(state: {
          terminalVisible?: boolean;
          agentPanelVisible?: boolean;
        }) {
          if (state.terminalVisible !== undefined) retainedDockVisible = state.terminalVisible;
        },
      },
      terminal: {
        getDockState: async () => ({
          terminalVisible: retainedDockVisible,
          agentPanelVisible: false,
        }),
      },
    };

    await renderEditorPane();

    // Restored: the dock comes back expanded without a user re-open, and the
    // restore reveal is NOT counted as a user-initiated terminal open.
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('true');
    expect(terminalOpenedCalls).toHaveLength(0);
  });

  // The agents half of "each panel keeps its own reload state". The terminal
  // half is covered above; without this the `if (state.agentPanelVisible)`
  // restore branch is never exercised, so deleting it — or letting the field
  // name drift across the IPC seam — would leave the panel collapsed after every
  // reload with nothing catching it.
  test('desktop: a reload re-expands an agents panel that was open before it', async () => {
    (window as { okDesktop?: unknown }).okDesktop = {
      config: { ptyAvailable: true },
      onMenuAction: () => () => {},
      editor: { notifyViewMenuStateChanged() {} },
      terminal: {
        getDockState: async () => ({ terminalVisible: false, agentPanelVisible: true }),
      },
    };

    await renderEditorPane();

    expect(screen.getByTestId('agents-panel').getAttribute('data-visible')).toBe('true');
    // Independent: restoring one panel must not drag the other open with it.
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
  });

  test('desktop: a reload with BOTH panels retained restores both', async () => {
    (window as { okDesktop?: unknown }).okDesktop = {
      config: { ptyAvailable: true },
      onMenuAction: () => () => {},
      editor: { notifyViewMenuStateChanged() {} },
      terminal: {
        getDockState: async () => ({ terminalVisible: true, agentPanelVisible: true }),
      },
    };

    await renderEditorPane();

    expect(screen.getByTestId('agents-panel').getAttribute('data-visible')).toBe('true');
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('true');
  });

  // The agents panel's launch intent had no coverage: the host mock captured
  // `launch` but dropped `threadLaunch`, so nothing proved EditorPane forwards it
  // (or that it reveals the panel first — a thread launched into a hidden panel
  // is invisible work).
  test('an agent-thread launch request reveals the agents panel and forwards the intent', async () => {
    await renderEditorPane();
    expect(screen.getByTestId('agents-panel').getAttribute('data-visible')).toBe('false');

    await act(async () => {
      requestAgentThreadLaunch({
        agentSource: 'registry',
        agentId: 'acme-agent',
        prompt: 'summarize this doc',
        docName: TEST_DOC,
        titleHint: null,
      });
    });

    const agents = screen.getByTestId('agents-panel');
    expect(agents.getAttribute('data-visible')).toBe('true');
    expect(agents.getAttribute('data-thread-launch-agent')).toBe('acme-agent');
    // A fresh one-shot: the nonce is what makes a repeat request a NEW launch
    // rather than a no-op re-render of the same intent.
    expect(agents.getAttribute('data-thread-launch-nonce')).not.toBe('none');
  });

  test('desktop: a rejecting getDockState still settles the gate so the view-menu push converges', async () => {
    // getDockState rejects (IPC torn down mid-reload). The restore's `.finally`
    // must still settle dockRestoreSettled so the deferred mount push lands —
    // mirrors TerminalDock's "rejecting list() still settles" guard. A
    // regression that settled only on the success branch would gate the View
    // menu's terminal item forever.
    const desk = makeOkDesktopStub(async () => {
      throw new Error('ipc boom');
    });
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    expect(desk.viewMenuPushes).toContainEqual({ terminalVisible: false });
    // With no restored state the dock stays hidden (the breadcrumb is logged).
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
  });

  // ⌃` is the dock's second chord. It carries no native accelerator (an Electron
  // menu item holds only one), so unlike ⌘J the renderer keydown is its ONLY
  // delivery path — on the one host where the terminal exists. If this listener
  // ever returns to a blanket `window.okDesktop != null` early-return, ⌃` dies
  // exactly where it is meant to work.
  test('desktop: Ctrl+` toggles the dock (the renderer owns the chord the menu does not)', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    const dock = () => screen.getByTestId('terminal-dock');
    expect(dock().getAttribute('data-visible')).toBe('false');

    function pressCtrlBacktick(): KeyboardEvent {
      const event = new KeyboardEvent('keydown', {
        key: '`',
        code: 'Backquote',
        ctrlKey: true,
        cancelable: true,
        bubbles: true,
      });
      act(() => {
        window.dispatchEvent(event);
      });
      return event;
    }

    expect(pressCtrlBacktick().defaultPrevented).toBe(true);
    expect(dock().getAttribute('data-visible')).toBe('true');
    // Toggles, per the VS Code / Zed convention — it does not open-only.
    pressCtrlBacktick();
    expect(dock().getAttribute('data-visible')).toBe('false');
  });

  // The other half of that gate: on desktop ⌘J arrives as an OS-captured menu
  // accelerator that dispatches `toggle-terminal`. If the renderer ALSO acted on
  // the keydown, one press would toggle twice — a net no-op that reads as a dead
  // shortcut.
  test('desktop: a Cmd/Ctrl+J keydown is left to the native menu (no double toggle)', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    const dock = () => screen.getByTestId('terminal-dock');
    const init: KeyboardEventInit = { key: 'j', cancelable: true, bubbles: true };
    if (isMacOS()) init.metaKey = true;
    else init.ctrlKey = true;
    const event = new KeyboardEvent('keydown', init);
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(dock().getAttribute('data-visible')).toBe('false');
    // The menu path is the one that acts on desktop.
    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(dock().getAttribute('data-visible')).toBe('true');
  });

  // With no selection AND no shell to spawn, ⌘J has nothing to do on the web
  // host, so it must leave the browser's own ⌘J alone. It used to preventDefault
  // and then hit a guard that can never be false — swallowing the chord for a
  // no-op. The selection-send path below is the half that DOES act here.
  test('web host: a Cmd/Ctrl+J keydown with no selection is NOT swallowed', async () => {
    await renderEditorPane();

    const init: KeyboardEventInit = { key: 'j', cancelable: true, bubbles: true };
    if (isMacOS()) init.metaKey = true;
    else init.ctrlKey = true;
    const event = new KeyboardEvent('keydown', init);
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  // ⌘L's twin. On desktop the native menu accelerator covers this, but the web
  // host has only the renderer listener and no fallback — if it were ever moved
  // inside the `window.okDesktop != null` early-return, or bound to the wrong
  // phase, ⌘L would silently do nothing there.
  test('web host: a Cmd/Ctrl+L keydown is intercepted (the agents toggle is wired)', async () => {
    await renderEditorPane();

    const init: KeyboardEventInit = { key: 'l', cancelable: true, bubbles: true };
    if (isMacOS()) init.metaKey = true;
    else init.ctrlKey = true;
    const event = new KeyboardEvent('keydown', init);
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  test('web host: an unrelated keydown is not intercepted', async () => {
    await renderEditorPane();

    const event = new KeyboardEvent('keydown', {
      key: 'g',
      metaKey: true,
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  test('desktop: ⇧⌘J with no selection asks the host for a preferred-AI session', async () => {
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub().stub;
    await renderEditorPane();
    const input = captureActiveTerminalInput();
    const preferred = capturePreferredSessionRequests();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', shiftJKeydownInit()));
    });
    input.stop();
    preferred.stop();

    // The hosts are asked to open the user's preferred AI. EditorPane names no
    // CLI and reveals NO panel: resolving here could only ever yield a CLI (what
    // made ⇧⌘J ignore a preferred ACP agent), and with two panels this pane
    // cannot know which one should end up on screen — the host that owns the
    // resolved kind reveals itself.
    expect(preferred.count).toBe(1);
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
    expect(screen.getByTestId('agents-panel').getAttribute('data-visible')).toBe('false');
    expect(screen.getByTestId('terminal-dock').getAttribute('data-launch-nonce')).toBe('none');
    expect(input.texts).toEqual([]);
  });

  test('desktop: ⇧⌘J with a selection sends the passage to the host as a NEW session', async () => {
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub().stub;
    await renderEditorPane();
    seedSelection('some highlighted text');
    const input = captureActiveTerminalInput();
    const preferred = capturePreferredSessionRequests();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', shiftJKeydownInit()));
    });
    input.stop();
    preferred.stop();

    // The passage rides the Ask-AI channel with `newTab` set, so the host that
    // owns the preferred family opens a fresh session instead of reusing one, and
    // reveals its own panel. Nothing is auto-run and no CLI is named here.
    const dock = screen.getByTestId('terminal-dock');
    expect(input.details).toHaveLength(1);
    expect(input.details[0]?.newTab).toBe(true);
    expect(input.details[0]?.text).toContain('some highlighted text');
    // Raw selected material, never an instruction: `submit` stays false so a
    // fresh session writes it and waits. A true here would auto-run a passage the
    // user only highlighted.
    expect(input.details[0]?.submit).toBe(false);
    // Trailing soft newlines land the caret on a blank line below the passage.
    expect(input.details[0]?.text.endsWith('\n\n')).toBe(true);
    // A selection send is not a promptless "new chat" request.
    expect(preferred.count).toBe(0);
    expect(dock.getAttribute('data-launch-nonce')).toBe('none');
  });

  test('desktop: ⇧⌘J claims the event (preventDefault)', async () => {
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub().stub;
    await renderEditorPane();
    const event = new KeyboardEvent('keydown', shiftJKeydownInit());
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  });

  test('web host: ⇧⌘J still asks for a preferred-AI session (the agents panel can answer)', async () => {
    await renderEditorPane();
    const preferred = capturePreferredSessionRequests();
    const event = new KeyboardEvent('keydown', shiftJKeydownInit());
    act(() => {
      window.dispatchEvent(event);
    });
    preferred.stop();

    // ⇧⌘J used to be gated on a terminal being available, which made it dead on
    // web. Agent threads are server-hosted, so the agents panel can always answer
    // — the chord is universal now and claims the keystroke.
    expect(event.defaultPrevented).toBe(true);
    expect(preferred.count).toBe(1);
  });

  test('desktop: ⌘J with a selection sends the passage to the host for reuse (no toggle, no launch)', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();
    seedSelection('run the build');
    const input = captureActiveTerminalInput();

    // ⌘J arrives via the OS-captured menu accelerator → the toggle-terminal action.
    act(() => desk.dispatchMenuAction('toggle-terminal'));
    input.stop();

    // ⌘J means "continue where I am when that makes sense", so `newTab` is unset
    // and the hosts decide: a running CLI or an open agent thread takes the
    // passage, otherwise the owner of the preferred family launches one and
    // reveals itself. EditorPane stages nothing and reveals nothing — whether the
    // active tab is a CLI, a bare shell, or an agent thread is knowledge only a
    // host has.
    const dock = screen.getByTestId('terminal-dock');
    expect(input.details).toHaveLength(1);
    expect(input.details[0]?.newTab).toBe(false);
    expect(input.details[0]?.text).toContain('run the build');
    expect(input.details[0]?.submit).toBe(false);
    // Trailing soft newlines land the caret on a blank line below the passage.
    expect(input.details[0]?.text.endsWith('\n\n')).toBe(true);
    expect(dock.getAttribute('data-launch-nonce')).toBe('none');
    // The selection send replaces the toggle, so ⌘J did NOT open the terminal.
    expect(dock.getAttribute('data-visible')).toBe('false');
  });

  test('desktop: ⌘J with no selection still toggles and stages nothing', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();
    const input = captureActiveTerminalInput();

    act(() => desk.dispatchMenuAction('toggle-terminal'));
    input.stop();

    const dock = screen.getByTestId('terminal-dock');
    expect(dock.getAttribute('data-visible')).toBe('true');
    expect(dock.getAttribute('data-launch-nonce')).toBe('none');
    expect(input.texts).toEqual([]);
  });
});
