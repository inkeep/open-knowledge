import { MarkdownManager, sharedExtensions, stripFrontmatter } from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Editor, getSchema, isMacOS } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { type ReactNode, type Ref, useEffect, useImperativeHandle } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { registerEditor, unregisterEditor } from '@/editor/active-editor';
import { collectImageParts } from '@/editor/composer-drop.test-helper';
import { publishSelectionContext } from '@/editor/selection-context';
import type { EditorSurface } from '@/editor/selection-stats';
import {
  clearPendingSourceNavigationsForTest,
  peekPendingSourceNavigation,
} from '@/editor/source-editor-navigation';
import { VIEW_IN_SOURCE_EVENT, type ViewInSourceDetail } from '@/editor/view-in-source-event';
import { resolveLauncherSelection } from '@/lib/acp/launcher-selection';
import {
  getDefaultRegisteredAgent,
  getRegisteredAgentOptions,
  pickEffectiveDefaultAgent,
  reloadRegisteredAgentsFromStorage,
  setDetectedRegisteredAgentSuggestions,
} from '@/lib/acp/registered-agents';
import { narrowWorkspaceSessionKey } from '@/lib/narrow-workspace-session';
import {
  __resetPaneVisibilityStoreForTests,
  type PaneId,
  paneVisibilityStore,
} from '@/lib/pane-visibility-store';
import { RESTORE_SETTLE_TIMEOUT_MS } from '@/lib/restore-settle-timeout';
import { revealEditor } from '@/lib/reveal-editor';
import {
  IN_APP_THREAD_ID,
  loadStickyAgent,
  saveStickyAgent,
  terminalCliId,
} from '@/lib/unified-agent-store';
import { subscribeToPreferredSessionRequests } from './handoff/preferred-session-events';
import { subscribeToActiveTerminalInput } from './handoff/terminal-input-events';
import {
  type AgentThreadLaunchDetail,
  requestAgentThreadLaunch,
} from './handoff/thread-launch-events';

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

const authoredPreferredStops: Array<() => void> = [];
function trackPreferredStop(stop: () => void): () => void {
  authoredPreferredStops.push(stop);
  return stop;
}

function currentPreferredKind() {
  return resolveLauncherSelection({
    sticky: loadStickyAgent(),
    effectiveThreadAgent: pickEffectiveDefaultAgent(
      getRegisteredAgentOptions(),
      getDefaultRegisteredAgent(),
    ),
    enabledClis: ['claude'],
    enabledDesktopTargets: [],
    installedClis: { claude: true },
    terminalAvailable: true,
    threadsAvailable: true,
    desktopSelectable: false,
    preferBareTerminal: false,
    bareTerminalFallback: true,
  }).kind;
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

let workspaceContentDir: string | null = '/tmp/project';
vi.doMock('@/lib/use-workspace', () => ({
  useWorkspace: () => ({ contentDir: workspaceContentDir, pathSeparator: '/' }),
}));

let activeProvider: { document: Y.Doc } | undefined;
let activeDocumentName: string | null = TEST_DOC;
vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({
    activeDocName: activeDocumentName,
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

type MockPlacements = {
  terminal: { container: HTMLElement | null; isShowing: boolean };
  agents: { container: HTMLElement | null; isShowing: boolean };
  editorRegion: HTMLElement | null;
};
let reportedPlacements: MockPlacements | null = null;

type MockPaneExtents = Record<PaneId, boolean>;
const PANES_WITH_EXTENT: MockPaneExtents = { agents: true, terminal: true };
let paneExtents: MockPaneExtents = { ...PANES_WITH_EXTENT };
let reportPaneExtentChange: (() => void) | undefined;

function setPaneExtent(pane: PaneId, hasExtent: boolean): void {
  paneExtents = { ...paneExtents, [pane]: hasExtent };
  act(() => reportPaneExtentChange?.());
}

type MockEditorAreaHandle = {
  panesOnScreen(): MockPaneExtents;
  bringBackPane(pane: PaneId): void;
};

function MockPaneExtentHandle({
  handleRef,
  onPaneExtentChange,
}: {
  handleRef?: Ref<MockEditorAreaHandle>;
  onPaneExtentChange?: () => void;
}) {
  reportPaneExtentChange = onPaneExtentChange;
  useImperativeHandle(handleRef, () => ({
    panesOnScreen: () => ({ ...paneExtents }),
    bringBackPane: (pane) => {
      paneExtents = { ...paneExtents, [pane]: true };
      onPaneExtentChange?.();
    },
  }));
  return null;
}

function ReportPlacements({
  onSessionPlacements,
}: {
  onSessionPlacements?: (placements: MockPlacements) => void;
}) {
  useEffect(() => {
    if (reportedPlacements !== null) onSessionPlacements?.(reportedPlacements);
  }, [onSessionPlacements]);
  return null;
}

vi.doMock('./EditorArea', () => ({
  EditorArea: ({
    ref,
    onPaneExtentChange,
    renderWorkspaceHeader,
    terminalPlacement,
    terminalRightWidth,
    editorVisible,
    onSessionPlacements,
  }: {
    ref?: Ref<MockEditorAreaHandle>;
    editorVisible?: boolean;
    onPaneExtentChange?: () => void;
    renderWorkspaceHeader?: (tabs: ReactNode, chrome: { trailing: ReactNode }) => ReactNode;
    terminalPlacement?: string;
    terminalRightWidth?: number;
    onSessionPlacements?: (placements: MockPlacements) => void;
  }) => (
    <div
      data-testid="editor-area"
      data-terminal-placement={terminalPlacement}
      data-terminal-right-width={terminalRightWidth}
      data-editor-visible={String(editorVisible)}
    >
      {renderWorkspaceHeader?.(<div data-testid="workspace-tabs" />, { trailing: null })}
      <ReportPlacements onSessionPlacements={onSessionPlacements} />
      <MockPaneExtentHandle handleRef={ref} onPaneExtentChange={onPaneExtentChange} />
    </div>
  ),
}));
vi.doMock('./acp/AgentThreadClientBinder', () => ({
  AgentThreadClientBinder: () => null,
}));
const sessionsHostFocusRequests: (() => void)[] = [];
let preferredHostReady: (() => void) | undefined;
let agentsHostVisibleChange: ((visible: boolean) => void) | undefined;
let terminalHostReady: (() => void) | undefined;
let terminalHostVisibleChange: ((visible: boolean) => void) | undefined;
vi.doMock('./SessionsHost', () => ({
  SessionsHost: ({
    surface,
    bridge,
    terminalCapable,
    terminalPlacement,
    onTerminalPlacementChange,
    visible,
    onVisibleChange,
    launch,
    threadLaunch,
    onRequestEditorFocus,
    onPreferredSessionHostReady,
  }: {
    surface: string;
    onRequestEditorFocus?: () => void;
    bridge?: unknown;
    terminalCapable?: boolean;
    terminalPlacement?: string;
    onTerminalPlacementChange?: (placement: 'bottom' | 'right') => void;
    visible?: boolean;
    onVisibleChange?: (visible: boolean) => void;
    onPreferredSessionHostReady?: () => void;
    launch?: {
      nonce: number;
      stagePaste?: string;
      cli?: string | null;
      command?: { executable: string; args: readonly string[] };
      label?: string;
      signInThreadId?: string;
    } | null;
    threadLaunch?: {
      nonce: number;
      agentId?: string;
      prompt?: string | null;
      docName?: string | null;
      titleHint?: string | null;
    } | null;
  }) => {
    if (onRequestEditorFocus != null) sessionsHostFocusRequests.push(onRequestEditorFocus);
    if (surface === 'agents-panel') {
      preferredHostReady = onPreferredSessionHostReady;
      agentsHostVisibleChange = onVisibleChange;
    } else {
      terminalHostReady = onPreferredSessionHostReady;
      terminalHostVisibleChange = onVisibleChange;
    }
    return (
      <div
        data-testid={surface === 'agents-panel' ? 'agents-panel' : 'terminal-dock'}
        data-has-bridge={String(bridge != null)}
        data-terminal-capable={String(terminalCapable === true)}
        data-terminal-placement={terminalPlacement}
        data-visible={String(visible)}
        data-launch-nonce={launch ? String(launch.nonce) : 'none'}
        data-launch-stage={launch?.stagePaste ?? 'none'}
        data-launch-cli={launch?.cli ?? 'none'}
        data-launch-command={launch?.command ? JSON.stringify(launch.command) : 'none'}
        data-launch-label={launch?.label ?? 'none'}
        data-launch-sign-in={launch?.signInThreadId ?? 'none'}
        data-thread-launch-nonce={threadLaunch ? String(threadLaunch.nonce) : 'none'}
        data-thread-launch-agent={threadLaunch?.agentId ?? 'none'}
        data-thread-launch-prompt={threadLaunch?.prompt ?? 'none'}
        data-thread-launch-document={threadLaunch?.docName ?? 'none'}
        data-thread-launch-title={threadLaunch?.titleHint ?? 'none'}
        data-thread-launch-image-parts={String(collectImageParts(threadLaunch).length)}
      >
        {surface === 'agents-panel' ? (
          <button type="button" onClick={() => onVisibleChange?.(true)}>
            mock SessionsHost requests reveal
          </button>
        ) : (
          <>
            <button type="button" onClick={() => onTerminalPlacementChange?.('right')}>
              Move mock Terminal right
            </button>
            <button type="button" onClick={() => onTerminalPlacementChange?.('bottom')}>
              Move mock Terminal bottom
            </button>
          </>
        )}
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
  AuthModal: ({ open, identityPrompt }: { open: boolean; identityPrompt?: boolean }) => (
    <div
      data-testid="auth-modal"
      data-open={String(open)}
      data-identity-prompt={String(identityPrompt === true)}
    />
  ),
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
  const view = render(<EditorPane />);
  await act(async () => {});
  return view;
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
  ] as const)(
    'stays closed when %s',
    async (_label, nextHasRemote, nextProjectSynced, nextSynced, nextProjectLocalConfig, nextProjectConfig) => {
      hasRemote = nextHasRemote;
      projectSynced = nextProjectSynced;
      projectLocalSynced = nextSynced;
      projectLocalConfig = nextProjectLocalConfig;
      projectConfig = nextProjectConfig;

      await renderEditorPane();

      expect(screen.getByTestId('auto-sync-onboarding').getAttribute('data-open')).toBe('false');
    },
  );

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
  editorVisible?: boolean;
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
    for (const stop of authoredPreferredStops.splice(0)) stop();
    cleanup();
    localStorage.clear();
    reloadRegisteredAgentsFromStorage();
    setDetectedRegisteredAgentSuggestions([]);
    delete (window as { okDesktop?: unknown }).okDesktop;
    terminalOpenedCalls.length = 0;
    clearSelection();
    activeProvider = undefined;
    clearPendingSourceNavigationsForTest();
    preferredHostReady = undefined;
    agentsHostVisibleChange = undefined;
    terminalHostReady = undefined;
    terminalHostVisibleChange = undefined;
    paneExtents = { ...PANES_WITH_EXTENT };
    workspaceContentDir = '/tmp/project';
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
    expect(agentsPush).toEqual({
      agentPanelVisible: true,
      wideIntent: { agentPanelVisible: true },
    });
  });

  test('desktop: toggle-terminal flips terminal visibility and pushes the view-menu state', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
    expect(desk.viewMenuPushes).toContainEqual({
      terminalVisible: false,
      wideIntent: { terminalVisible: false },
    });

    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('true');
    expect(desk.viewMenuPushes.at(-1)).toEqual({
      terminalVisible: true,
      wideIntent: { terminalVisible: true },
    });

    act(() => desk.dispatchMenuAction('toggle-terminal'));
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
    expect(desk.viewMenuPushes.at(-1)).toEqual({
      terminalVisible: false,
      wideIntent: { terminalVisible: false },
    });
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

  test('desktop: a command launch and a sign-in CLI launch reach the dock with their command, label and chat', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    const { requestTerminalCommandLaunch, requestTerminalLaunch } = await import(
      './handoff/terminal-launch-events'
    );
    await renderEditorPane();
    const dock = () => screen.getByTestId('terminal-dock');

    act(() =>
      requestTerminalCommandLaunch({
        label: 'Log in with Auggie',
        command: { executable: 'auggie', args: ['--acp', 'login'] },
        signInThreadId: 'thread-9',
      }),
    );
    expect(dock().getAttribute('data-visible')).toBe('true');
    expect(dock().getAttribute('data-launch-nonce')).toBe('1');
    expect(dock().getAttribute('data-launch-cli')).toBe('none');
    expect(dock().getAttribute('data-launch-command')).toBe(
      JSON.stringify({ executable: 'auggie', args: ['--acp', 'login'] }),
    );
    expect(dock().getAttribute('data-launch-label')).toBe('Log in with Auggie');
    expect(dock().getAttribute('data-launch-sign-in')).toBe('thread-9');

    act(() => requestTerminalLaunch('', 'claude', { signInThreadId: 'thread-9' }));
    expect(dock().getAttribute('data-launch-nonce')).toBe('2');
    expect(dock().getAttribute('data-launch-cli')).toBe('claude');
    expect(dock().getAttribute('data-launch-command')).toBe('none');
    expect(dock().getAttribute('data-launch-sign-in')).toBe('thread-9');
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

  test('desktop: view in source with the editor hidden shows the editor before it jumps', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    const markdown = '# Title\n\nfirst paragraph\n\ntarget paragraph';
    const ydoc = new Y.Doc();
    ydoc.getText('source').insert(0, markdown);
    activeProvider = { document: ydoc };
    const editor = makeJumpEditor(markdown, 3);
    registerEditor('docs/notes', editor);
    const editorShownAtJump: Array<string | null> = [];
    const onFlip = () =>
      editorShownAtJump.push(screen.getByTestId('editor-area').getAttribute('data-editor-visible'));
    window.addEventListener(VIEW_IN_SOURCE_EVENT, onFlip);

    await renderEditorPane();
    act(() => paneVisibilityStore.request('editor', false));
    act(() => desk.dispatchMenuAction('toggle-source'));

    window.removeEventListener(VIEW_IN_SOURCE_EVENT, onFlip);
    unregisterEditor('docs/notes', editor);

    expect(editorShownAtJump).toEqual(['true']);
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

  test('a SessionsHost reveal request opens the agents panel', async () => {
    const user = userEvent.setup();
    await renderEditorPane();

    expect(screen.getByTestId('agents-panel').getAttribute('data-visible')).toBe('false');

    await user.click(screen.getByRole('button', { name: 'mock SessionsHost requests reveal' }));

    expect(screen.getByTestId('agents-panel').getAttribute('data-visible')).toBe('true');
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
        attachments: null,
      });
    });

    const agents = screen.getByTestId('agents-panel');
    expect(agents.getAttribute('data-visible')).toBe('true');
    expect(agents.getAttribute('data-thread-launch-agent')).toBe('acme-agent');
    expect(agents.getAttribute('data-thread-launch-nonce')).not.toBe('none');
  });

  test('desktop: a narrow session close reports closed wide intent while the menu tracks the projection', async () => {
    const notified: Array<{
      agentPanelVisible?: boolean;
      wideIntent?: { agentPanelVisible?: boolean };
    }> = [];
    (window as { okDesktop?: unknown }).okDesktop = {
      config: { ptyAvailable: true },
      onMenuAction: () => () => {},
      editor: {
        notifyViewMenuStateChanged(state: (typeof notified)[number]) {
          notified.push(state);
        },
      },
      terminal: {
        getDockState: async () => ({ terminalVisible: false, agentPanelVisible: true }),
      },
    };
    const originalMatchMedia = window.matchMedia;
    const narrowQuery = originalMatchMedia('(width < 48rem)');
    Object.defineProperty(narrowQuery, 'matches', { configurable: true, value: true });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) =>
        query === '(width < 48rem)' ? narrowQuery : originalMatchMedia(query),
    });
    const lastWideAgents = () =>
      notified.filter((state) => state.wideIntent?.agentPanelVisible !== undefined).at(-1);

    try {
      await renderEditorPane();
      await act(async () => agentsHostVisibleChange?.(true));
      expect(screen.getByTestId('agents-panel').getAttribute('data-visible')).toBe('true');
      expect(lastWideAgents()?.wideIntent?.agentPanelVisible).toBe(true);

      await act(async () =>
        (
          agentsHostVisibleChange as
            | ((visible: boolean, reason?: 'session-close') => void)
            | undefined
        )?.(false, 'session-close'),
      );

      expect(lastWideAgents()).toMatchObject({
        agentPanelVisible: false,
        wideIntent: { agentPanelVisible: false },
      });
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  test('a narrow agent launch selects Chat while retaining its document and attachment intent', async () => {
    const originalMatchMedia = window.matchMedia;
    const narrowQuery = originalMatchMedia('(width < 48rem)');
    Object.defineProperty(narrowQuery, 'matches', { configurable: true, value: true });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) =>
        query === '(width < 48rem)' ? narrowQuery : originalMatchMedia(query),
    });

    try {
      await renderEditorPane();
      expect(screen.getByTestId('editor-area').getAttribute('data-editor-visible')).toBe('true');

      await act(async () => {
        requestAgentThreadLaunch({
          agentSource: 'registry',
          agentId: 'acme-agent',
          prompt: 'describe the screenshot',
          docName: TEST_DOC,
          titleHint: 'Notes',
          attachments: [
            {
              kind: 'image',
              mimeType: 'image/png',
              data: 'iVBORw==',
              name: 'drop-me.png',
              sizeBytes: 4,
            },
          ],
        });
      });

      expect(screen.getByTestId('editor-area').getAttribute('data-editor-visible')).toBe('false');
      expect(screen.getByTestId('agents-panel').getAttribute('data-visible')).toBe('true');
      expect(screen.getByTestId('agents-panel').getAttribute('data-thread-launch-agent')).toBe(
        'acme-agent',
      );
      expect(screen.getByTestId('agents-panel').getAttribute('data-thread-launch-prompt')).toBe(
        'describe the screenshot',
      );
      expect(screen.getByTestId('agents-panel').getAttribute('data-thread-launch-document')).toBe(
        TEST_DOC,
      );
      expect(screen.getByTestId('agents-panel').getAttribute('data-thread-launch-title')).toBe(
        'Notes',
      );
      expect(
        screen.getByTestId('agents-panel').getAttribute('data-thread-launch-image-parts'),
      ).toBe('1');
      expect(paneVisibilityStore.getSnapshot().agents?.open).toBe(true);
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  test('a launch request carrying an image attachment forwards it into the thread-launch intent', async () => {
    await renderEditorPane();

    await act(async () => {
      requestAgentThreadLaunch({
        agentSource: 'registry',
        agentId: 'acme-agent',
        prompt: 'describe the screenshot',
        docName: TEST_DOC,
        titleHint: null,
        attachments: [
          {
            kind: 'image',
            mimeType: 'image/png',
            data: 'iVBORw==',
            name: 'drop-me.png',
            sizeBytes: 4,
          },
        ],
      } as AgentThreadLaunchDetail);
    });

    const agents = screen.getByTestId('agents-panel');
    expect(agents.getAttribute('data-thread-launch-agent')).toBe('acme-agent');
    expect(agents.getAttribute('data-thread-launch-image-parts')).toBe('1');
  });

  test('desktop: a rejecting getDockState still settles the gate (placement push lands; visibility stays silent)', async () => {
    const desk = makeOkDesktopStub(async () => {
      throw new Error('ipc boom');
    });
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    expect(desk.viewMenuPushes).toContainEqual({ terminalPlacement: 'bottom' });
    expect(desk.viewMenuPushes).not.toContainEqual({
      terminalVisible: false,
      wideIntent: { terminalVisible: false },
    });
    expect(desk.viewMenuPushes).not.toContainEqual({
      agentPanelVisible: false,
      wideIntent: { agentPanelVisible: false },
    });
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

  test('web host: a no-selection shortcut reaches the preferred request before a session host subscribes', async () => {
    await renderEditorPane();
    clearSelection();
    window.getSelection()?.removeAllRanges();
    const preferred = capturePreferredSessionRequests();
    const input = captureActiveTerminalInput();
    const event = new KeyboardEvent('keydown', shiftJKeydownInit());

    expect(window.getSelection()?.toString()).toBe('');
    act(() => {
      window.dispatchEvent(event);
    });
    preferred.stop();
    input.stop();

    expect(event.defaultPrevented).toBe(true);
    expect(preferred.count).toBe(1);
    expect(input.details).toEqual([]);
    expect(screen.getByTestId('agents-panel').getAttribute('data-visible')).toBe('false');
  });

  test('web host: a cold shortcut is delivered once when its session host becomes ready', async () => {
    await renderEditorPane();
    const keyEvent = new KeyboardEvent('keydown', shiftJKeydownInit());
    act(() => {
      window.dispatchEvent(keyEvent);
    });
    expect(keyEvent.defaultPrevented).toBe(true);

    let launches = 0;
    const stop = subscribeToPreferredSessionRequests(() => {
      launches += 1;
    });
    act(() => preferredHostReady?.());
    stop();

    expect(launches).toBe(1);
  });

  test('web host: two cold shortcuts deliver two accepted requests without replay on another ready signal', async () => {
    await renderEditorPane();
    const first = new KeyboardEvent('keydown', shiftJKeydownInit());
    const second = new KeyboardEvent('keydown', shiftJKeydownInit());
    act(() => {
      window.dispatchEvent(first);
      window.dispatchEvent(second);
    });
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);

    let launches = 0;
    const stop = subscribeToPreferredSessionRequests(() => {
      launches += 1;
    });
    act(() => preferredHostReady?.());
    expect(launches).toBe(2);
    act(() => preferredHostReady?.());
    stop();

    expect(launches).toBe(2);
  });

  test('web host: zero-width collapse keeps a cold request but explicit Hide cancels the next one', async () => {
    await renderEditorPane();
    act(() => agentsHostVisibleChange?.(true));
    setPaneExtent('agents', false);
    const first = new KeyboardEvent('keydown', shiftJKeydownInit());
    act(() => window.dispatchEvent(first));
    expect(first.defaultPrevented).toBe(true);

    let launches = 0;
    const stopFirst = subscribeToPreferredSessionRequests(() => {
      launches += 1;
    });
    act(() => preferredHostReady?.());
    expect(launches).toBe(1);
    stopFirst();

    const second = new KeyboardEvent('keydown', shiftJKeydownInit());
    act(() => window.dispatchEvent(second));
    expect(second.defaultPrevented).toBe(true);
    act(() => agentsHostVisibleChange?.(false));
    const stopSecond = subscribeToPreferredSessionRequests(() => {
      launches += 1;
    });
    act(() => preferredHostReady?.());
    stopSecond();

    expect(screen.getByTestId('agents-panel').getAttribute('data-visible')).toBe('false');
    expect(launches).toBe(1);
  });

  test('web host: project switch and unmount discard the prior owner’s cold request', async () => {
    const view = await renderEditorPane();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', shiftJKeydownInit())));

    let launches = 0;
    const stopFirst = subscribeToPreferredSessionRequests(() => {
      launches += 1;
    });
    act(() => preferredHostReady?.());
    expect(launches).toBe(1);
    stopFirst();

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', shiftJKeydownInit())));
    workspaceContentDir = '/tmp/other-project';
    const { EditorPane } = await import('./EditorPane');
    act(() => view.rerender(<EditorPane />));
    const stopAfterSwitch = subscribeToPreferredSessionRequests(() => {
      launches += 1;
    });
    act(() => preferredHostReady?.());
    expect(launches).toBe(1);
    stopAfterSwitch();

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', shiftJKeydownInit())));
    act(() => view.unmount());
    render(<EditorPane />);
    const stopAfterRemount = subscribeToPreferredSessionRequests(() => {
      launches += 1;
    });
    act(() => preferredHostReady?.());
    stopAfterRemount();

    expect(launches).toBe(1);
  });

  test('desktop: a pending shortcut follows a changed preference into an already ready terminal host', async () => {
    setDetectedRegisteredAgentSuggestions([{ source: 'registry', id: 'acme-agent', name: 'Acme' }]);
    saveStickyAgent(IN_APP_THREAD_ID);
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub().stub;
    await renderEditorPane();
    expect(currentPreferredKind()).toBe('thread');
    const launches: string[] = [];
    const stopTerminal = trackPreferredStop(
      Reflect.apply(subscribeToPreferredSessionRequests, undefined, [
        () => launches.push('terminal'),
        window,
        () => currentPreferredKind() === 'cli',
      ]) as () => void,
    );
    act(() => terminalHostReady?.());
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', shiftJKeydownInit())));
    expect(launches).toEqual([]);

    act(() => saveStickyAgent(terminalCliId('claude')));
    expect(currentPreferredKind()).toBe('cli');
    expect(launches).toEqual(['terminal']);
    act(() => terminalHostReady?.());
    stopTerminal();
    expect(launches).toEqual(['terminal']);
  });

  test('desktop: a pending shortcut follows catalog loss to the current CLI route', async () => {
    setDetectedRegisteredAgentSuggestions([{ source: 'registry', id: 'acme-agent', name: 'Acme' }]);
    saveStickyAgent(IN_APP_THREAD_ID);
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub().stub;
    const view = await renderEditorPane();
    const { EditorPane } = await import('./EditorPane');
    expect(currentPreferredKind()).toBe('thread');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', shiftJKeydownInit())));

    let launches = 0;
    const stop = trackPreferredStop(
      Reflect.apply(subscribeToPreferredSessionRequests, undefined, [
        () => {
          launches += 1;
        },
        window,
        () => currentPreferredKind() === 'cli',
      ]) as () => void,
    );
    expect(launches).toBe(0);

    act(() => {
      setDetectedRegisteredAgentSuggestions([]);
      view.rerender(<EditorPane />);
    });
    expect(currentPreferredKind()).toBe('cli');
    act(() => terminalHostReady?.());
    stop();
    expect(launches).toBe(1);
  });

  test('desktop: hiding the other pane keeps a pending shortcut, while hiding its current destination cancels it', async () => {
    setDetectedRegisteredAgentSuggestions([{ source: 'registry', id: 'acme-agent', name: 'Acme' }]);
    saveStickyAgent(IN_APP_THREAD_ID);
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub().stub;
    await renderEditorPane();
    expect(currentPreferredKind()).toBe('thread');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', shiftJKeydownInit())));
    act(() => saveStickyAgent(terminalCliId('claude')));
    expect(currentPreferredKind()).toBe('cli');
    act(() => agentsHostVisibleChange?.(false));

    let launches = 0;
    const subscribeTerminal = () =>
      trackPreferredStop(
        Reflect.apply(subscribeToPreferredSessionRequests, undefined, [
          () => {
            launches += 1;
          },
          window,
          () => currentPreferredKind() === 'cli',
        ]) as () => void,
      );
    const stopFirst = subscribeTerminal();
    act(() => terminalHostReady?.());
    expect(launches).toBe(1);
    stopFirst();

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', shiftJKeydownInit())));
    act(() => terminalHostVisibleChange?.(false));
    const stopSecond = subscribeTerminal();
    act(() => terminalHostReady?.());
    stopSecond();
    expect(launches).toBe(1);
  });

  test('web host: a stale ready callback cannot drain requests from a new project or mount', async () => {
    const view = await renderEditorPane();
    const oldReady = preferredHostReady;
    const { EditorPane } = await import('./EditorPane');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', shiftJKeydownInit())));
    workspaceContentDir = '/tmp/other-project';
    act(() => view.rerender(<EditorPane />));
    const projectReady = preferredHostReady;
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', shiftJKeydownInit())));

    let launches = 0;
    const stop = trackPreferredStop(
      subscribeToPreferredSessionRequests(() => {
        launches += 1;
      }),
    );
    act(() => oldReady?.());
    const launchesAfterOldReady = launches;
    act(() => projectReady?.());
    expect(launches).toBe(1);
    expect(launchesAfterOldReady).toBe(0);
    stop();

    act(() => view.unmount());
    render(<EditorPane />);
    const nextReady = preferredHostReady;
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', shiftJKeydownInit())));
    expect(launches).toBe(1);
    const stopAfterRemount = trackPreferredStop(
      subscribeToPreferredSessionRequests(() => {
        launches += 1;
      }),
    );
    act(() => projectReady?.());
    const launchesAfterStaleReady = launches;
    act(() => nextReady?.());
    stopAfterRemount();
    expect(launchesAfterStaleReady).toBe(1);
    expect(launches).toBe(2);
  });

  test('web host: an unknown workspace binds its first project, then retires intent on a known-project switch', async () => {
    workspaceContentDir = null;
    const view = await renderEditorPane();
    const { EditorPane } = await import('./EditorPane');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', shiftJKeydownInit())));
    workspaceContentDir = '/tmp/project-a';
    act(() => view.rerender(<EditorPane />));

    let launches = 0;
    const stop = trackPreferredStop(
      subscribeToPreferredSessionRequests(() => {
        launches += 1;
      }),
    );
    act(() => preferredHostReady?.());
    expect(launches).toBe(1);
    stop();

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', shiftJKeydownInit())));
    expect(launches).toBe(1);
    workspaceContentDir = '/tmp/project-b';
    act(() => view.rerender(<EditorPane />));
    const stopAfterSwitch = trackPreferredStop(
      subscribeToPreferredSessionRequests(() => {
        launches += 1;
      }),
    );
    act(() => preferredHostReady?.());
    expect(launches).toBe(1);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', shiftJKeydownInit())));
    stopAfterSwitch();
    expect(launches).toBe(2);
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

  test('selection handoff reads the active document and editing surface after rerender', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    const view = await renderEditorPane();
    const { EditorPane } = await import('./EditorPane');
    seedSelection('old document selection');
    const input = captureActiveTerminalInput();
    try {
      act(() => desk.dispatchMenuAction('toggle-agent-panel'));
      activeDocumentName = 'docs/other';
      publishSelectionContext('docs/other', 'wysiwyg', {
        surface: 'wysiwyg',
        docName: 'docs/other',
        markdown: 'wrong surface selection',
        charLen: 23,
        lineCount: 1,
      });
      publishSelectionContext('docs/other', 'source', {
        surface: 'source',
        docName: 'docs/other',
        markdown: 'current source selection',
        charLen: 24,
        lineCount: 1,
      });
      act(() => view.rerender(<EditorPane />));
      act(() =>
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            code: 'KeyM',
            key: 'm',
            altKey: true,
            metaKey: true,
            ctrlKey: true,
            bubbles: true,
          }),
        ),
      );
      act(() => desk.dispatchMenuAction('toggle-agent-panel'));
      act(() => window.dispatchEvent(new KeyboardEvent('keydown', shiftJKeydownInit())));

      expect(input.details).toHaveLength(3);
      expect(input.details[1]).toMatchObject({ newTab: false, submit: false, target: 'agents' });
      expect(input.details[2]).toMatchObject({ newTab: true, submit: false });
      for (const detail of input.details.slice(1)) {
        expect(detail.text).toContain('current source selection');
        expect(detail.text).not.toContain('old document selection');
        expect(detail.text).not.toContain('wrong surface selection');
        expect(detail.text.endsWith('\n\n')).toBe(true);
      }
    } finally {
      input.stop();
      activeDocumentName = TEST_DOC;
      publishSelectionContext('docs/other', 'wysiwyg', null);
      publishSelectionContext('docs/other', 'source', null);
    }
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

describe('EditorPane pane visibility for the header', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    delete (window as { okDesktop?: unknown }).okDesktop;
    terminalOpenedCalls.length = 0;
    reportedPlacements = null;
    paneExtents = { ...PANES_WITH_EXTENT };
    clearSelection();
    __resetPaneVisibilityStoreForTests();
  });

  test('web host reports chat and no terminal', async () => {
    await renderEditorPane();

    expect(paneVisibilityStore.getSnapshot()).toEqual({
      editor: { open: true, onScreen: true },
      agents: { open: false, onScreen: false },
      terminal: null,
    });
  });

  test('desktop host with a working shell reports both panes', async () => {
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub().stub;
    await renderEditorPane();

    expect(paneVisibilityStore.getSnapshot()).toEqual({
      editor: { open: true, onScreen: true },
      agents: { open: false, onScreen: false },
      terminal: { open: false, onScreen: false },
    });
  });

  test('desktop host without a working shell reports no terminal', async () => {
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub(undefined, false).stub;
    await renderEditorPane();

    expect(paneVisibilityStore.getSnapshot().terminal).toBeNull();
    expect(paneVisibilityStore.getSnapshot().agents).toEqual({ open: false, onScreen: false });
  });

  test('a note window reports neither pane', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = {
      ...desk.stub,
      config: { ...desk.stub.config, mode: 'note' },
    };
    await renderEditorPane();

    expect(screen.getByTestId('editor-area')).toBeTruthy();
    expect(paneVisibilityStore.getSnapshot()).toEqual({
      editor: null,
      agents: null,
      terminal: null,
    });
  });

  test('the snapshot follows the other show and hide paths', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();
    const seen: string[] = [];
    const stop = paneVisibilityStore.subscribe(() => {
      const { agents, terminal } = paneVisibilityStore.getSnapshot();
      seen.push(`agents=${agents?.open} terminal=${terminal?.open}`);
    });

    act(() => desk.dispatchMenuAction('toggle-agent-panel'));
    act(() => desk.dispatchMenuAction('toggle-terminal'));
    act(() => desk.dispatchMenuAction('toggle-agent-panel'));
    stop();

    expect(seen).toEqual([
      'agents=true terminal=false',
      'agents=true terminal=true',
      'agents=false terminal=true',
    ]);
    expect(paneVisibilityStore.getSnapshot().terminal).toEqual({ open: true, onScreen: true });
  });

  test('a pending extent report reads visibility after the parent rerenders', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();
    const pendingReport = reportPaneExtentChange;
    expect(pendingReport).toBeDefined();

    act(() => desk.dispatchMenuAction('toggle-agent-panel'));
    expect(paneVisibilityStore.getSnapshot().agents).toEqual({ open: true, onScreen: true });

    paneExtents = { ...paneExtents, agents: false };
    act(() => pendingReport?.());
    expect(paneVisibilityStore.getSnapshot().agents).toEqual({ open: true, onScreen: false });
  });

  test('an open pane the layout collapses to zero size reads open but not on screen, at once', async () => {
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub(async () => ({
      terminalVisible: true,
      agentPanelVisible: true,
    })).stub;
    await renderEditorPane();
    expect(paneVisibilityStore.getSnapshot()).toEqual({
      editor: { open: true, onScreen: true },
      agents: { open: true, onScreen: true },
      terminal: { open: true, onScreen: true },
    });

    setPaneExtent('agents', false);

    expect(screen.getByTestId('agents-panel').getAttribute('data-visible')).toBe('true');
    expect(paneVisibilityStore.getSnapshot()).toEqual({
      editor: { open: true, onScreen: true },
      agents: { open: true, onScreen: false },
      terminal: { open: true, onScreen: true },
    });

    setPaneExtent('agents', true);
    expect(paneVisibilityStore.getSnapshot().agents).toEqual({ open: true, onScreen: true });
  });

  test('a hidden pane reads off even while the layout still gives it size', async () => {
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub().stub;
    await renderEditorPane();

    expect(paneVisibilityStore.getSnapshot()).toEqual({
      editor: { open: true, onScreen: true },
      agents: { open: false, onScreen: false },
      terminal: { open: false, onScreen: false },
    });
  });

  test('a show request for an open pane at zero size brings it back without hiding and reshowing it', async () => {
    const desk = makeOkDesktopStub(async () => ({
      terminalVisible: true,
      agentPanelVisible: true,
    }));
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();
    setPaneExtent('terminal', false);
    setPaneExtent('agents', false);
    const opensBefore = terminalOpenedCalls.length;
    const menuPushesBefore = desk.viewMenuPushes.length;

    act(() => paneVisibilityStore.request('terminal', true));
    act(() => paneVisibilityStore.request('agents', true));

    expect(paneVisibilityStore.getSnapshot()).toEqual({
      editor: { open: true, onScreen: true },
      agents: { open: true, onScreen: true },
      terminal: { open: true, onScreen: true },
    });
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('true');
    expect(screen.getByTestId('agents-panel').getAttribute('data-visible')).toBe('true');
    expect(terminalOpenedCalls).toHaveLength(opensBefore);
    expect(desk.viewMenuPushes.slice(menuPushesBefore)).toEqual([]);
  });

  test('a hide request for a pane on screen still hides it', async () => {
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub(async () => ({
      terminalVisible: true,
      agentPanelVisible: true,
    })).stub;
    await renderEditorPane();

    act(() => paneVisibilityStore.request('terminal', false));

    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
    expect(paneVisibilityStore.getSnapshot().terminal).toEqual({ open: false, onScreen: false });
  });

  test('a header request shows and hides chat', async () => {
    await renderEditorPane();
    const agents = () => screen.getByTestId('agents-panel').getAttribute('data-visible');

    act(() => paneVisibilityStore.request('agents', true));
    expect(agents()).toBe('true');
    expect(paneVisibilityStore.getSnapshot().agents?.open).toBe(true);

    act(() => paneVisibilityStore.request('agents', true));
    expect(agents()).toBe('true');

    act(() => paneVisibilityStore.request('agents', false));
    expect(agents()).toBe('false');
    expect(paneVisibilityStore.getSnapshot().agents?.open).toBe(false);
  });

  test('desktop: a header request shows and hides the terminal and publishes the level to the view menu', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();
    const terminal = () => screen.getByTestId('terminal-dock').getAttribute('data-visible');

    act(() => paneVisibilityStore.request('terminal', true));
    expect(terminal()).toBe('true');
    expect(desk.viewMenuPushes.at(-1)).toEqual({
      terminalVisible: true,
      wideIntent: { terminalVisible: true },
    });

    act(() => paneVisibilityStore.request('terminal', false));
    expect(terminal()).toBe('false');
    expect(desk.viewMenuPushes.at(-1)).toEqual({
      terminalVisible: false,
      wideIntent: { terminalVisible: false },
    });

    act(() => paneVisibilityStore.request('agents', true));
    expect(desk.viewMenuPushes.at(-1)).toEqual({
      agentPanelVisible: true,
      wideIntent: { agentPanelVisible: true },
    });
  });

  test('desktop: a header show records one terminal open and a header hide records none', async () => {
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub().stub;
    await renderEditorPane();
    expect(terminalOpenedCalls).toHaveLength(0);

    act(() => paneVisibilityStore.request('terminal', true));
    expect(terminalOpenedCalls).toHaveLength(1);

    act(() => paneVisibilityStore.request('terminal', false));
    expect(terminalOpenedCalls).toHaveLength(1);
  });

  test('desktop without a working shell ignores a terminal request', async () => {
    const desk = makeOkDesktopStub(undefined, false);
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    act(() => paneVisibilityStore.request('terminal', true));

    expect(screen.queryByTestId('terminal-dock')).toBeNull();
    expect(desk.viewMenuPushes).not.toContainEqual({
      terminalVisible: true,
      wideIntent: { terminalVisible: true },
    });
    expect(terminalOpenedCalls).toHaveLength(0);
  });

  test('a note window ignores header requests', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = {
      ...desk.stub,
      config: { ...desk.stub.config, mode: 'note' },
    };
    await renderEditorPane();
    expect(desk.viewMenuPushes).toContainEqual({
      agentPanelVisible: false,
      wideIntent: { agentPanelVisible: false },
    });

    act(() => paneVisibilityStore.request('agents', true));
    act(() => paneVisibilityStore.request('terminal', true));

    expect(desk.viewMenuPushes).not.toContainEqual({
      agentPanelVisible: true,
      wideIntent: { agentPanelVisible: true },
    });
    expect(desk.viewMenuPushes).not.toContainEqual({
      terminalVisible: true,
      wideIntent: { terminalVisible: true },
    });
  });

  test('with text selected a header request opens chat and stages nothing, while the chat shortcut still stages it', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();
    seedSelection('run the build');
    const agents = () => screen.getByTestId('agents-panel').getAttribute('data-visible');
    const input = captureActiveTerminalInput();

    act(() => paneVisibilityStore.request('agents', true));
    expect(agents()).toBe('true');
    expect(input.texts).toEqual([]);

    act(() => paneVisibilityStore.request('agents', false));
    expect(agents()).toBe('false');
    expect(input.texts).toEqual([]);

    act(() => desk.dispatchMenuAction('toggle-agent-panel'));
    input.stop();
    expect(agents()).toBe('false');
    expect(input.details).toHaveLength(1);
    expect(input.details[0]?.target).toBe('agents');
    expect(input.details[0]?.text).toContain('run the build');
  });

  test('with the editor hidden, ⌘/Ctrl+L toggles chat and never stages the hidden selection', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();
    seedSelection('run the build');
    const agents = () => screen.getByTestId('agents-panel').getAttribute('data-visible');
    act(() => paneVisibilityStore.request('editor', false));
    const input = captureActiveTerminalInput();

    act(() => desk.dispatchMenuAction('toggle-agent-panel'));
    expect(agents()).toBe('true');
    act(() => desk.dispatchMenuAction('toggle-agent-panel'));
    expect(agents()).toBe('false');
    input.stop();

    expect(input.texts).toEqual([]);
    expect(desk.viewMenuPushes).toContainEqual({ hasEditorSelection: false });
  });

  test('a retained selection cannot stage text while narrow Chat covers Editor', async () => {
    const originalMatchMedia = window.matchMedia;
    const narrowQuery = originalMatchMedia('(width < 48rem)');
    Object.defineProperty(narrowQuery, 'matches', { configurable: true, value: true });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) =>
        query === '(width < 48rem)' ? narrowQuery : originalMatchMedia(query),
    });
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    try {
      await renderEditorPane();
      seedSelection('run the build');
      act(() => paneVisibilityStore.request('agents', true));
      expect(screen.getByTestId('editor-area').getAttribute('data-editor-visible')).toBe('false');
      const input = captureActiveTerminalInput();

      act(() => desk.dispatchMenuAction('toggle-agent-panel'));
      input.stop();

      expect(input.texts).toEqual([]);
      expect(screen.getByTestId('editor-area').getAttribute('data-editor-visible')).toBe('true');
      expect(desk.viewMenuPushes).toContainEqual({ hasEditorSelection: false });
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  test('with the editor hidden, ⇧⌘J opens a plain new session and never stages the hidden selection', async () => {
    (window as { okDesktop?: unknown }).okDesktop = makeOkDesktopStub().stub;
    await renderEditorPane();
    seedSelection('run the build');
    act(() => paneVisibilityStore.request('editor', false));
    const input = captureActiveTerminalInput();
    const preferred = capturePreferredSessionRequests();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', shiftJKeydownInit()));
    });
    input.stop();
    preferred.stop();

    expect(input.texts).toEqual([]);
    expect(preferred.count).toBe(1);
  });

  test('with the editor shown again, ⌘/Ctrl+L stages the selection as before', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();
    seedSelection('run the build');
    act(() => paneVisibilityStore.request('editor', false));
    act(() => paneVisibilityStore.request('editor', true));
    const input = captureActiveTerminalInput();

    act(() => desk.dispatchMenuAction('toggle-agent-panel'));
    input.stop();

    expect(input.details).toHaveLength(1);
    expect(input.details[0]?.text).toContain('run the build');
  });

  test('a header hide leaves focus where it was', async () => {
    const editorRegion = document.createElement('div');
    editorRegion.tabIndex = -1;
    document.body.append(editorRegion);
    reportedPlacements = {
      terminal: { container: null, isShowing: false },
      agents: { container: document.createElement('div'), isShowing: true },
      editorRegion,
    };
    await renderEditorPane();
    act(() => paneVisibilityStore.request('agents', true));
    const headerButton = document.createElement('button');
    document.body.append(headerButton);
    headerButton.focus();

    act(() => paneVisibilityStore.request('agents', false));

    expect(screen.getByTestId('agents-panel').getAttribute('data-visible')).toBe('false');
    expect(document.activeElement).toBe(headerButton);
    headerButton.remove();
    editorRegion.remove();
  });

  test('a project window shows the editor by default and applies header hide and show requests', async () => {
    await renderEditorPane();
    const editorArea = screen.getByTestId('editor-area');
    expect(editorArea.getAttribute('data-editor-visible')).toBe('true');
    expect(paneVisibilityStore.getSnapshot().editor).toEqual({ open: true, onScreen: true });

    act(() => paneVisibilityStore.request('editor', false));
    expect(editorArea.getAttribute('data-editor-visible')).toBe('false');
    expect(paneVisibilityStore.getSnapshot().editor).toEqual({ open: false, onScreen: false });

    act(() => paneVisibilityStore.request('editor', true));
    expect(editorArea.getAttribute('data-editor-visible')).toBe('true');
    expect(paneVisibilityStore.getSnapshot().editor).toEqual({ open: true, onScreen: true });
  });

  test('a single-file window keeps its Editor return destination and restricts Hide', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = {
      ...desk.stub,
      config: { ...desk.stub.config, singleFile: true },
    };
    const { EditorPane } = await import('./EditorPane');
    const { SingleFileModeProvider } = await import('@/lib/single-file-mode');
    render(
      <SingleFileModeProvider>
        <EditorPane />
      </SingleFileModeProvider>,
    );
    await act(async () => {});

    expect(paneVisibilityStore.getSnapshot().editor).toEqual({ open: true, onScreen: true });
    act(() => paneVisibilityStore.request('editor', false));
    expect(screen.getByTestId('editor-area').getAttribute('data-editor-visible')).toBe('true');
  });

  test('a narrow single-file window rejects an empty restored selection', async () => {
    const originalMatchMedia = window.matchMedia;
    const narrowQuery = originalMatchMedia('(width < 48rem)');
    Object.defineProperty(narrowQuery, 'matches', { configurable: true, value: true });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) =>
        query === '(width < 48rem)' ? narrowQuery : originalMatchMedia(query),
    });
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = {
      ...desk.stub,
      config: { ...desk.stub.config, singleFile: true },
    };
    const key = narrowWorkspaceSessionKey('/tmp/project', 'desktop');
    sessionStorage.setItem(key, JSON.stringify({ version: 1, selected: null }));

    try {
      const { EditorPane } = await import('./EditorPane');
      const { SingleFileModeProvider } = await import('@/lib/single-file-mode');
      render(
        <SingleFileModeProvider>
          <EditorPane />
        </SingleFileModeProvider>,
      );
      await act(async () => {});

      expect(screen.getByTestId('editor-area').getAttribute('data-editor-visible')).toBe('true');
    } finally {
      sessionStorage.removeItem(key);
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  test('delayed browser single-file configuration replaces an empty restored selection', async () => {
    const originalMatchMedia = window.matchMedia;
    const originalFetch = globalThis.fetch;
    const narrowQuery = originalMatchMedia('(width < 48rem)');
    Object.defineProperty(narrowQuery, 'matches', { configurable: true, value: true });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) =>
        query === '(width < 48rem)' ? narrowQuery : originalMatchMedia(query),
    });
    let resolveConfig: (response: Response) => void = () => {};
    globalThis.fetch = vi.fn((input: RequestInfo | URL) =>
      String(input) === '/api/config'
        ? new Promise<Response>((resolve) => {
            resolveConfig = resolve;
          })
        : Promise.resolve(new Response(null, { status: 404 })),
    );
    const key = narrowWorkspaceSessionKey('/tmp/project', 'web');
    sessionStorage.setItem(key, JSON.stringify({ version: 1, selected: null }));

    try {
      const { EditorPane } = await import('./EditorPane');
      const { SingleFileModeProvider } = await import('@/lib/single-file-mode');
      render(
        <SingleFileModeProvider>
          <EditorPane />
        </SingleFileModeProvider>,
      );
      await act(async () => {});
      expect(screen.getByTestId('editor-area').getAttribute('data-editor-visible')).toBe('false');

      await act(async () => {
        resolveConfig(new Response(JSON.stringify({ singleFile: true }), { status: 200 }));
      });
      expect(screen.getByTestId('editor-area').getAttribute('data-editor-visible')).toBe('true');
    } finally {
      sessionStorage.removeItem(key);
      globalThis.fetch = originalFetch;
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  test('a pane hiding while the editor is hidden sends focus to the header Editor button, not the page', async () => {
    const editorRegion = document.createElement('div');
    editorRegion.tabIndex = -1;
    document.body.append(editorRegion);
    reportedPlacements = {
      terminal: { container: null, isShowing: false },
      agents: { container: document.createElement('div'), isShowing: true },
      editorRegion,
    };
    const editorButton = document.createElement('button');
    editorButton.setAttribute('data-header-pane-button', 'editor');
    document.body.append(editorButton);
    await renderEditorPane();
    act(() => paneVisibilityStore.request('editor', false));

    act(() => sessionsHostFocusRequests.at(-1)?.());

    expect(document.activeElement).toBe(editorButton);
    editorButton.remove();
    editorRegion.remove();
  });
});

describe('EditorPane saves and restores whether the editor is shown', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    delete (window as { okDesktop?: unknown }).okDesktop;
    __resetPaneVisibilityStoreForTests();
  });

  const editorVisibleAttr = () =>
    screen.getByTestId('editor-area').getAttribute('data-editor-visible');

  test('desktop: a saved hidden editor comes back hidden, published only once the restore settles', async () => {
    const desk = makeOkDesktopStub(async () => ({
      terminalVisible: false,
      agentPanelVisible: false,
      editorVisible: false,
    }));
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    expect(editorVisibleAttr()).toBe('false');
    expect(desk.viewMenuPushes).toContainEqual({
      editorVisible: false,
      wideIntent: { editorVisible: false },
    });
    expect(desk.viewMenuPushes).not.toContainEqual({
      editorVisible: true,
      wideIntent: { editorVisible: true },
    });
  });

  test('desktop: a saved hidden editor that lands after the settle bound still comes back hidden', async () => {
    let release: (value: DockStateResult) => void = () => {};
    const desk = makeOkDesktopStub(
      () =>
        new Promise<DockStateResult>((resolve) => {
          release = resolve;
        }),
    );
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await renderEditorPane();
      await act(async () => {
        vi.advanceTimersByTime(RESTORE_SETTLE_TIMEOUT_MS + 1);
      });
      expect(editorVisibleAttr()).toBe('true');

      await act(async () => {
        release({ terminalVisible: false, agentPanelVisible: false, editorVisible: false });
      });
    } finally {
      vi.useRealTimers();
    }

    expect(editorVisibleAttr()).toBe('false');
    expect(desk.viewMenuPushes).toContainEqual({
      editorVisible: false,
      wideIntent: { editorVisible: false },
    });
    expect(desk.viewMenuPushes).not.toContainEqual({
      editorVisible: true,
      wideIntent: { editorVisible: true },
    });
  });

  async function renderPastTheSettleBound() {
    let release: (value: DockStateResult) => void = () => {};
    const desk = makeOkDesktopStub(
      () =>
        new Promise<DockStateResult>((resolve) => {
          release = resolve;
        }),
    );
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await renderEditorPane();
      await act(async () => {
        vi.advanceTimersByTime(RESTORE_SETTLE_TIMEOUT_MS + 1);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(editorVisibleAttr()).toBe('true');
    const land = (value: DockStateResult) => act(async () => release(value));
    return { desk, land };
  }

  test('desktop: a show requested after the settle bound is not undone by a late saved hidden editor', async () => {
    const { desk, land } = await renderPastTheSettleBound();
    act(() => paneVisibilityStore.request('editor', true));
    await land({ terminalVisible: false, agentPanelVisible: false, editorVisible: false });

    expect(editorVisibleAttr()).toBe('true');
    expect(desk.viewMenuPushes).not.toContainEqual({
      editorVisible: false,
      wideIntent: { editorVisible: false },
    });
  });

  test('desktop: a hide after the settle bound is not undone by a late saved shown editor', async () => {
    const { desk, land } = await renderPastTheSettleBound();
    act(() => paneVisibilityStore.request('editor', false));
    expect(editorVisibleAttr()).toBe('false');
    await land({ terminalVisible: false, agentPanelVisible: false, editorVisible: true });

    expect(editorVisibleAttr()).toBe('false');
    const editorPushes = desk.viewMenuPushes.filter((push) => 'editorVisible' in push);
    expect(editorPushes.at(-1)).toEqual({
      editorVisible: false,
      wideIntent: { editorVisible: false },
    });
  });

  test("desktop: View menu toggles after the settle bound are the user's choice, and a late saved hidden editor does not undo them", async () => {
    const { desk, land } = await renderPastTheSettleBound();
    act(() => desk.dispatchMenuAction('toggle-editor'));
    expect(editorVisibleAttr()).toBe('false');
    act(() => desk.dispatchMenuAction('toggle-editor'));
    expect(editorVisibleAttr()).toBe('true');
    await land({ terminalVisible: false, agentPanelVisible: false, editorVisible: false });

    expect(editorVisibleAttr()).toBe('true');
    const editorPushes = desk.viewMenuPushes.filter((push) => 'editorVisible' in push);
    expect(editorPushes.at(-1)).toEqual({
      editorVisible: true,
      wideIntent: { editorVisible: true },
    });
  });

  test('desktop: a late saved layout with the editor hidden and chat open keeps the editor shown', async () => {
    const { desk, land } = await renderPastTheSettleBound();
    await land({ terminalVisible: false, agentPanelVisible: true, editorVisible: false });

    expect(editorVisibleAttr()).toBe('true');
    expect(desk.viewMenuPushes).not.toContainEqual({
      editorVisible: false,
      wideIntent: { editorVisible: false },
    });
  });

  test('desktop: a late saved layout with the editor hidden and the terminal open keeps the editor shown', async () => {
    const { desk, land } = await renderPastTheSettleBound();
    await land({ terminalVisible: true, agentPanelVisible: false, editorVisible: false });

    expect(editorVisibleAttr()).toBe('true');
    expect(screen.getByTestId('terminal-dock').getAttribute('data-visible')).toBe('false');
    expect(desk.viewMenuPushes).not.toContainEqual({
      editorVisible: false,
      wideIntent: { editorVisible: false },
    });
    expect(desk.viewMenuPushes).not.toContainEqual({
      terminalVisible: true,
      wideIntent: { terminalVisible: true },
    });
  });

  test('desktop: a record from before the editor field opens with the editor shown', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    expect(editorVisibleAttr()).toBe('true');
    expect(desk.viewMenuPushes).not.toContainEqual({
      editorVisible: false,
      wideIntent: { editorVisible: false },
    });
  });

  test('desktop: the editor stays shown through the restore wait, and an open during the wait keeps it shown', async () => {
    let release: (value: DockStateResult) => void = () => {};
    const desk = makeOkDesktopStub(
      () =>
        new Promise<DockStateResult>((resolve) => {
          release = resolve;
        }),
    );
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();
    expect(editorVisibleAttr()).toBe('true');
    expect(paneVisibilityStore.getSnapshot().editor).toEqual({ open: true, onScreen: true });
    expect(desk.viewMenuPushes.some((push) => 'editorVisible' in push)).toBe(false);

    act(() => paneVisibilityStore.request('editor', true));
    await act(async () => {
      release({ terminalVisible: false, agentPanelVisible: false, editorVisible: false });
    });

    expect(editorVisibleAttr()).toBe('true');
  });

  test('desktop: a deep link that opens a document before the editor pane mounts keeps a saved-hidden editor shown', async () => {
    const desk = makeOkDesktopStub(async () => ({
      terminalVisible: false,
      agentPanelVisible: false,
      editorVisible: false,
    }));
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    revealEditor();

    await renderEditorPane();

    expect(editorVisibleAttr()).toBe('true');
    expect(desk.viewMenuPushes).not.toContainEqual({
      editorVisible: false,
      wideIntent: { editorVisible: false },
    });
  });

  test('desktop: a reveal in a single-file window leaves nothing behind for a later project window', async () => {
    const singleFile = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = {
      ...singleFile.stub,
      config: { ...singleFile.stub.config, singleFile: true },
    };
    const { EditorPane } = await import('./EditorPane');
    const { SingleFileModeProvider } = await import('@/lib/single-file-mode');
    render(
      <SingleFileModeProvider>
        <EditorPane />
      </SingleFileModeProvider>,
    );
    await act(async () => {});
    act(() => revealEditor());
    cleanup();

    const project = makeOkDesktopStub(async () => ({
      terminalVisible: false,
      agentPanelVisible: false,
      editorVisible: false,
    }));
    (window as { okDesktop?: unknown }).okDesktop = project.stub;
    await renderEditorPane();

    expect(editorVisibleAttr()).toBe('false');
  });

  test('desktop: a document opened during the restore wait keeps a saved-hidden editor shown', async () => {
    let release: (value: DockStateResult) => void = () => {};
    const desk = makeOkDesktopStub(
      () =>
        new Promise<DockStateResult>((resolve) => {
          release = resolve;
        }),
    );
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    act(() => revealEditor());
    await act(async () => {
      release({ terminalVisible: false, agentPanelVisible: false, editorVisible: false });
    });

    expect(editorVisibleAttr()).toBe('true');
  });

  test('desktop: every pane saved hidden reopens to nothing shown', async () => {
    const desk = makeOkDesktopStub(async () => ({
      terminalVisible: false,
      agentPanelVisible: false,
      editorVisible: false,
    }));
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    expect(paneVisibilityStore.getSnapshot()).toEqual({
      editor: { open: false, onScreen: false },
      agents: { open: false, onScreen: false },
      terminal: { open: false, onScreen: false },
    });
  });

  test('desktop: the View menu toggle hides and shows the editor and publishes the level', async () => {
    const desk = makeOkDesktopStub();
    (window as { okDesktop?: unknown }).okDesktop = desk.stub;
    await renderEditorPane();

    act(() => desk.dispatchMenuAction('toggle-editor'));
    expect(editorVisibleAttr()).toBe('false');
    expect(desk.viewMenuPushes).toContainEqual({
      editorVisible: false,
      wideIntent: { editorVisible: false },
    });
    const pushesWhileHidden = desk.viewMenuPushes.length;
    act(() => desk.dispatchMenuAction('toggle-editor'));
    expect(editorVisibleAttr()).toBe('true');
    expect(desk.viewMenuPushes.slice(pushesWhileHidden)).toContainEqual({
      editorVisible: true,
      wideIntent: { editorVisible: true },
    });
  });

  test('web: the editor level survives a reload in both directions, under its own key', async () => {
    localStorage.setItem('ok-editor-visible-v1', 'false');
    await renderEditorPane();
    expect(editorVisibleAttr()).toBe('false');

    act(() => paneVisibilityStore.request('editor', true));
    cleanup();
    await renderEditorPane();
    expect(editorVisibleAttr()).toBe('true');

    act(() => paneVisibilityStore.request('editor', false));
    cleanup();
    await renderEditorPane();
    expect(editorVisibleAttr()).toBe('false');
    expect(localStorage.getItem('ok-editor-visible-v1')).toBe('false');
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

  test('a mode flip after the provider changes reads the current document', async () => {
    const firstDocument = new Y.Doc();
    const secondDocument = new Y.Doc();
    const firstSource = vi.spyOn(firstDocument, 'getText');
    const secondSource = vi.spyOn(secondDocument, 'getText');
    activeProvider = { document: firstDocument };
    const view = await renderEditorPane();

    pressModeToggle();
    expect(firstSource).toHaveBeenCalledWith('source');

    activeProvider = { document: secondDocument };
    const { EditorPane } = await import('./EditorPane');
    act(() => view.rerender(<EditorPane />));
    firstSource.mockClear();
    secondSource.mockClear();
    pressModeToggle();

    expect(secondSource).toHaveBeenCalledWith('source');
    expect(firstSource).not.toHaveBeenCalled();
    expect(promotePreviewTabMock).toHaveBeenCalledTimes(2);
    expect(promotePreviewTabMock).toHaveBeenNthCalledWith(2, 'docs/notes');
  });

  test('a flip with no provider yet promotes nothing', async () => {
    activeProvider = undefined;
    await renderEditorPane();

    pressModeToggle();

    expect(promotePreviewTabMock).not.toHaveBeenCalled();
  });
});

describe('EditorPane auth prompts', () => {
  afterEach(() => {
    cleanup();
  });

  test.each([
    { requested: 'identity', identityPrompt: 'true' },
    { requested: 'auth', identityPrompt: 'false' },
  ] as const)(
    'a $requested request from outside the pane opens the auth modal at that step',
    async ({ requested, identityPrompt }) => {
      const { authPromptStore } = await import('@/lib/auth-prompt-store');
      await renderEditorPane();
      expect(screen.getByTestId('auth-modal').getAttribute('data-open')).toBe('false');

      await act(async () => {
        authPromptStore.request(requested);
      });

      const modal = screen.getByTestId('auth-modal');
      expect(modal.getAttribute('data-open')).toBe('true');
      expect(modal.getAttribute('data-identity-prompt')).toBe(identityPrompt);
      expect(authPromptStore.getSnapshot()).toBeNull();
    },
  );

  test('a request that names no step opens the sign-in step', async () => {
    const { authPromptStore } = await import('@/lib/auth-prompt-store');
    await renderEditorPane();

    await act(async () => {
      authPromptStore.request();
    });

    const modal = screen.getByTestId('auth-modal');
    expect(modal.getAttribute('data-open')).toBe('true');
    expect(modal.getAttribute('data-identity-prompt')).toBe('false');
  });
});
