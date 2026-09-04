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

const TEST_DOC = 'docs/notes';

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

const jumpMd = new MarkdownManager({ extensions: sharedExtensions });
const jumpSchema = getSchema(sharedExtensions);

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

type CapturedInput = {
  text: string;
  newTab: boolean;
  submit: boolean;
  target: 'agents' | undefined;
};

function captureActiveTerminalInput(): {
  texts: string[];
  details: CapturedInput[];
  stop: () => void;
} {
  const texts: string[] = [];
  const details: CapturedInput[] = [];
  const stop = subscribeToActiveTerminalInput((detail) => {
    texts.push(detail.text);
    details.push({
      text: detail.text,
      newTab: detail.newTab,
      submit: detail.submit,
      target: detail.target,
    });
  });
  return { texts, details, stop };
}

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

let activeProvider: { document: Y.Doc } | undefined;
vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: 'docs/notes',
    collabUrl: 'ws://test',
    activeProvider,
  }),
  isBlobRunnerNewTabId: () => false,
}));

const promotePreviewTabMock = vi.fn(() => {});
vi.doMock('@/editor/preview-tab-promotion', () => ({
  requestPreviewTabPromotion: promotePreviewTabMock,
}));

vi.doMock('@/editor/use-editor-mode', () => ({
  useEditorMode: () => ['wysiwyg', () => {}],
}));

vi.doMock('./EditorHeader', () => ({
  EditorHeader: ({ children }: { children?: ReactNode }) => (
    <div data-testid="editor-header">{children}</div>
  ),
}));

vi.doMock('./EditorArea', () => ({
  EditorArea: ({
    renderWorkspaceHeader,
    terminalPlacement,
    terminalRightWidth,
  }: {
    renderWorkspaceHeader?: (tabs: ReactNode) => ReactNode;
    terminalPlacement?: string;
    terminalRightWidth?: number;
  }) => (
    <div
      data-testid="editor-area"
      data-terminal-placement={terminalPlacement}
      data-terminal-right-width={terminalRightWidth}
    >
      {renderWorkspaceHeader?.(<div data-testid="workspace-tabs" />)}
    </div>
  ),
}));
vi.doMock('./acp/AgentThreadClientBinder', () => ({
  AgentThreadClientBinder: () => null,
}));
vi.doMock('./SessionsHost', () => ({
  SessionsHost: ({
    surface,
    bridge,
    terminalCapable,
    terminalPlacement,
    onTerminalPlacementChange,
    reserveRightRevealTabGutter,
    visible,
    launch,
    threadLaunch,
  }: {
    surface: string;
    bridge?: unknown;
    terminalCapable?: boolean;
    terminalPlacement?: string;
    onTerminalPlacementChange?: (placement: 'bottom' | 'right') => void;
    reserveRightRevealTabGutter?: boolean;
    visible?: boolean;
    launch?: { nonce: number; stagePaste?: string } | null;
    threadLaunch?: { nonce: number; agentId?: string; prompt?: string | null } | null;
  }) => {
    return (
      <div
        data-testid={surface === 'agents-panel' ? 'agents-panel' : 'terminal-dock'}
        data-has-bridge={String(bridge != null)}
        data-terminal-capable={String(terminalCapable === true)}
        data-terminal-placement={terminalPlacement}
        data-reserve-right-reveal-gutter={String(reserveRightRevealTabGutter === true)}
        data-visible={String(visible)}
        data-launch-nonce={launch ? String(launch.nonce) : 'none'}
        data-launch-stage={launch?.stagePaste ?? 'none'}
        data-thread-launch-nonce={threadLaunch ? String(threadLaunch.nonce) : 'none'}
        data-thread-launch-agent={threadLaunch?.agentId ?? 'none'}
      >
        {surface === 'terminal-dock' ? (
          <>
            <button type="button" onClick={() => onTerminalPlacementChange?.('right')}>
              Move mock Terminal right
            </button>
            <button type="button" onClick={() => onTerminalPlacementChange?.('bottom')}>
              Move mock Terminal bottom
            </button>
          </>
        ) : null}
      </div>
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
    projectLocalConfig = { autoSync: {} };
    projectConfig = { autoSync: { default: null } };

    await renderEditorPane();

    expect(screen.getByTestId('auto-sync-onboarding').getAttribute('data-open')).toBe('true');
  });

  test.each([
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

type DockStateResult = {
  terminalVisible: boolean;
  agentPanelVisible: boolean;
  placement?: 'bottom' | 'right';
  rightWidth?: number;
};
function makeOkDesktopStub(
  getDockState: () => Promise<DockStateResult> = async () => ({
    terminalVisible: false,
    agentPanelVisible: false,
  }),
  ptyAvailable = true,
) {
  const menuHandlers: Array<(action: string) => void> = [];
  const viewMenuPushes: Array<{
    terminalVisible?: boolean;
    agentPanelVisible?: boolean;
    canViewInSource?: boolean;
  }> = [];
  const dockStateUpdates: unknown[] = [];
  return {
    viewMenuPushes,
    dockStateUpdates,
    dispatchMenuAction(action: string) {
      for (const cb of menuHandlers) cb(action);
    },
    stub: {
      config: { ptyAvailable },
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
        setDockState(state: unknown) {
          dockStateUpdates.push(state);
        },
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
    localStorage.clear();
    delete (window as { okDesktop?: unknown }).okDesktop;
    terminalOpenedCalls.length = 0;
    clearSelection();
    activeProvider = undefined;
    clearPendingSourceNavigationsForTest();
  });

  test('web host mounts the agents panel only — no shell can spawn, so no terminal dock', async () => {
    await renderEditorPane();

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

    expect(screen.getByTestId('editor-header')).toBeTruthy();
    expect(screen.getByTestId('editor-area')).toBeTruthy();
    for (const testid of ['terminal-dock', 'agents-panel']) {
      const panel = screen.getByTestId(testid);
      expect(panel.getAttribute('data-has-bridge')).toBe('true');
      expect(panel.getAttribute('data-terminal-capable')).toBe('true');
    }
  });

  test('desktop host without PTY capability keeps the terminal dock unmounted', async () => {
    const desk = makeOkDesktopStub(undefined, false);
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    expect(screen.queryByTestId('terminal-dock')).toBeNull();
    expect(screen.getByTestId('agents-panel').getAttribute('data-terminal-capable')).toBe('false');

    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(screen.queryByTestId('terminal-dock')).toBeNull();
  });

  test('desktop: the two panels open and close independently', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    const terminal = () => screen.getByTestId('terminal-dock').getAttribute('data-visible');
    const agents = () => screen.getByTestId('agents-panel').getAttribute('data-visible');
    expect(terminal()).toBe('false');
    expect(agents()).toBe('false');

    act(() => desk.dispatchMenuAction('toggle-agent-panel'));
    expect(agents()).toBe('true');
    expect(terminal()).toBe('false');

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

    const agentsPush = desk.viewMenuPushes.at(-1);
    expect(agentsPush).toEqual({ agentPanelVisible: true });
  });

  test('desktop: toggle-terminal flips terminal visibility and pushes the view-menu state', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
    expect(desk.viewMenuPushes).toContainEqual({ terminalVisible: false });

    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('true');
    expect(desk.viewMenuPushes.at(-1)).toEqual({ terminalVisible: true });

    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
    expect(desk.viewMenuPushes.at(-1)).toEqual({ terminalVisible: false });
  });

  test('desktop: move-terminal changes home while terminal toggles preserve it', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    const placement = () =>
      screen.getByTestId('editor-area').getAttribute('data-terminal-placement');

    expect(placement()).toBe('bottom');

    act(() => desk.dispatchMenuAction('move-terminal'));
    expect(placement()).toBe('right');

    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(placement()).toBe('right');

    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(placement()).toBe('right');

    act(() => desk.dispatchMenuAction('move-terminal'));
    expect(placement()).toBe('bottom');
  });

  test('desktop: hiding the terminal clears the launch intent so a reopen is blank (regression)', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    const { requestTerminalLaunch } = await import('./handoff/terminal-launch-events');
    await renderEditorPane();

    const dock = () => screen.getByTestId('terminal-dock');
    expect(dock().getAttribute('data-launch-nonce')).toBe('none');

    act(() => requestTerminalLaunch('work on docs/notes', 'claude'));
    expect(dock().getAttribute('data-visible')).toBe('true');
    expect(dock().getAttribute('data-launch-nonce')).toBe('1');

    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(dock().getAttribute('data-visible')).toBe('false');
    expect(dock().getAttribute('data-launch-nonce')).toBe('none');

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

    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(dock().getAttribute('data-launch-nonce')).toBe('none');

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
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;

    const markdown = '# Title\n\nfirst paragraph\n\ntarget paragraph';
    const ydoc = new Y.Doc();
    ydoc.getText('source').insert(0, markdown);
    activeProvider = { document: ydoc };
    const editor = makeJumpEditor(markdown, 3);
    registerEditor('docs/notes', editor);

    const flips: string[] = [];
    const onFlip = (e: Event) => flips.push((e as CustomEvent<ViewInSourceDetail>).detail.docName);
    window.addEventListener(VIEW_IN_SOURCE_EVENT, onFlip);

    await renderEditorPane();
    act(() => desk.dispatchMenuAction('toggle-source'));

    window.removeEventListener(VIEW_IN_SOURCE_EVENT, onFlip);
    unregisterEditor('docs/notes', editor);

    expect(flips).toEqual(['docs/notes']);
    const nav = peekPendingSourceNavigation('docs/notes');
    if (nav?.kind !== 'selection-offset') throw new Error('expected a selection-offset nav');
    expect(nav.intent).toBe('jump');
  });

  test('desktop: pushes the view-in-source capability for the context-menu row', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;

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

    expect(terminalOpenedCalls).toHaveLength(0);

    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(terminalOpenedCalls).toHaveLength(1);

    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(terminalOpenedCalls).toHaveLength(1);

    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(terminalOpenedCalls).toHaveLength(2);
  });

  test('desktop: a reload re-expands a dock that was open before it (retained visibility is not clobbered)', async () => {
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

    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('true');
    expect(terminalOpenedCalls).toHaveLength(0);
  });

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
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
  });

  test('desktop: a reload with BOTH panels retained restores both', async () => {
    localStorage.setItem('ok-terminal-placement-v1', 'right');
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
    expect(
      screen.getByTestId('terminal-dock').getAttribute('data-reserve-right-reveal-gutter'),
    ).toBe('false');
  });

  test('desktop: per-install right layout reaches both editor and stable terminal host', async () => {
    localStorage.setItem('ok-terminal-placement-v1', 'right');
    localStorage.setItem('ok-terminal-right-width-v1', '812');
    const desk = makeOkDesktopStub(async () => ({
      terminalVisible: true,
      agentPanelVisible: false,
    }));
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;

    await renderEditorPane();

    expect(screen.getByTestId('editor-area').getAttribute('data-terminal-placement')).toBe('right');
    expect(screen.getByTestId('editor-area').getAttribute('data-terminal-right-width')).toBe('812');
    expect(screen.getByTestId('terminal-dock').getAttribute('data-terminal-placement')).toBe(
      'right',
    );
    expect(
      screen.getByTestId('terminal-dock').getAttribute('data-reserve-right-reveal-gutter'),
    ).toBe('true');
    expect(desk.dockStateUpdates).toEqual([]);
  });

  test('desktop: a late project-state restore cannot override a user-owned per-install layout', async () => {
    localStorage.setItem('ok-terminal-placement-v1', 'right');
    localStorage.setItem('ok-terminal-right-width-v1', '812');
    let resolveDockState: ((state: DockStateResult) => void) | undefined;
    const desk = makeOkDesktopStub(
      () =>
        new Promise<DockStateResult>((resolve) => {
          resolveDockState = resolve;
        }),
    );
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    const { EditorPane } = await import('./EditorPane');
    render(<EditorPane />);

    expect(screen.getByTestId('editor-area').getAttribute('data-terminal-placement')).toBe('right');
    expect(screen.getByTestId('editor-area').getAttribute('data-terminal-right-width')).toBe('812');

    await userEvent.click(screen.getByRole('button', { name: 'Move mock Terminal bottom' }));
    expect(screen.getByTestId('editor-area').getAttribute('data-terminal-placement')).toBe(
      'bottom',
    );

    await act(async () => {
      resolveDockState?.({
        terminalVisible: false,
        agentPanelVisible: false,
        placement: 'right',
        rightWidth: 480,
      });
    });

    expect(screen.getByTestId('editor-area').getAttribute('data-terminal-placement')).toBe(
      'bottom',
    );
    expect(screen.getByTestId('editor-area').getAttribute('data-terminal-right-width')).toBe('812');
    expect(desk.dockStateUpdates).toEqual([]);
  });

  test('desktop: the stable terminal host can move the shared layout in both directions', async () => {
    const user = userEvent.setup();
    (window as { okDesktop?: unknown }).okDesktop = {
      config: { ptyAvailable: true },
      onMenuAction: () => () => {},
      editor: { notifyViewMenuStateChanged() {} },
      terminal: {
        getDockState: async () => ({ terminalVisible: true, agentPanelVisible: false }),
      },
    };
    await renderEditorPane();

    await user.click(screen.getByRole('button', { name: 'Move mock Terminal right' }));
    expect(screen.getByTestId('editor-area').getAttribute('data-terminal-placement')).toBe('right');
    expect(screen.getByTestId('terminal-dock').getAttribute('data-terminal-placement')).toBe(
      'right',
    );

    await user.click(screen.getByRole('button', { name: 'Move mock Terminal bottom' }));
    expect(screen.getByTestId('editor-area').getAttribute('data-terminal-placement')).toBe(
      'bottom',
    );
    expect(screen.getByTestId('terminal-dock').getAttribute('data-terminal-placement')).toBe(
      'bottom',
    );
  });

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
    expect(agents.getAttribute('data-thread-launch-nonce')).not.toBe('none');
  });

  test('desktop: a rejecting getDockState still settles the gate so the view-menu push converges', async () => {
    const desk = makeOkDesktopStub(async () => {
      throw new Error('ipc boom');
    });
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    expect(desk.viewMenuPushes).toContainEqual({ terminalVisible: false });
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
  });

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
    pressCtrlBacktick();
    expect(dock().getAttribute('data-visible')).toBe('false');
  });

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
    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(dock().getAttribute('data-visible')).toBe('true');
  });

  test('web host: a Cmd/Ctrl+J keydown with no selection is NOT swallowed', async () => {
    await renderEditorPane();

    const init: KeyboardEventInit = { key: 'j', cancelable: true, bubbles: true };
    if (isMacOS()) init.metaKey = true;
    else init.ctrlKey = true;
    const event = new KeyboardEvent('keydown', init);
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

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

    const dock = screen.getByTestId('terminal-dock');
    expect(input.details).toHaveLength(1);
    expect(input.details[0]?.newTab).toBe(true);
    expect(input.details[0]?.text).toContain('some highlighted text');
    expect(input.details[0]?.submit).toBe(false);
    expect(input.details[0]?.text.endsWith('\n\n')).toBe(true);
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

    expect(event.defaultPrevented).toBe(true);
    expect(preferred.count).toBe(1);
  });

  test('desktop: ⌘J with a selection toggles the terminal and stages nothing', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();
    seedSelection('run the build');
    const input = captureActiveTerminalInput();

    act(() => desk.dispatchMenuAction('toggle-terminal'));
    input.stop();

    const dock = screen.getByTestId('terminal-dock');
    expect(input.texts).toEqual([]);
    expect(dock.getAttribute('data-visible')).toBe('true');
    expect(dock.getAttribute('data-launch-nonce')).toBe('none');
  });

  test('desktop: ⌘L with a selection stages it for the agents panel and does not toggle', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();
    seedSelection('run the build');
    const input = captureActiveTerminalInput();

    act(() => desk.dispatchMenuAction('toggle-agent-panel'));
    input.stop();

    expect(input.details).toHaveLength(1);
    expect(input.details[0]?.target).toBe('agents');
    expect(input.details[0]?.newTab).toBe(false);
    expect(input.details[0]?.submit).toBe(false);
    expect(input.details[0]?.text).toContain('run the build');
    expect(input.details[0]?.text.endsWith('\n\n')).toBe(true);
    expect(screen.getByTestId('agents-panel').getAttribute('data-visible')).toBe('false');
  });

  test('desktop: ⌘L with no selection still toggles the agents panel', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();
    const input = captureActiveTerminalInput();

    act(() => desk.dispatchMenuAction('toggle-agent-panel'));
    input.stop();

    expect(input.texts).toEqual([]);
    expect(screen.getByTestId('agents-panel').getAttribute('data-visible')).toBe('true');
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

describe('EditorPane mode switch promotes the preview tab', () => {
  afterEach(() => {
    cleanup();
    delete (window as { okDesktop?: unknown }).okDesktop;
    promotePreviewTabMock.mockClear();
    activeProvider = undefined;
    clearPendingSourceNavigationsForTest();
  });

  function pressModeToggle() {
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          code: 'KeyM',
          key: 'm',
          altKey: true,
          metaKey: true,
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });
  }

  test('flipping a doc between source and WYSIWYG promotes its tab', async () => {
    activeProvider = { document: new Y.Doc() };
    await renderEditorPane();

    pressModeToggle();

    expect(promotePreviewTabMock).toHaveBeenCalledWith('docs/notes');
  });

  test('a flip with no provider yet promotes nothing', async () => {
    activeProvider = undefined;
    await renderEditorPane();

    pressModeToggle();

    expect(promotePreviewTabMock).not.toHaveBeenCalled();
  });
});
