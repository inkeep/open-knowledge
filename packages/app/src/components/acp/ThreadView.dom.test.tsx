/**
 * RTL mount tests for the thread-rendering parity surfaces: the terminal
 * card (command + output + exit badge), the genuine line diff, the explicit
 * Deny path and kind-aware resolution summaries, dead-turn permission
 * gating, the awaiting-permission transcript line, the context-usage ring
 * (shown only once a percentage is computable), and the raw tool-input block.
 * Invocation via `bun run test:dom`.
 */

import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type {
  RenderedItem,
  RenderedTerminal,
  ThreadRenderModel,
} from '@/lib/acp/thread-event-model';
import { MockComposerMentionInput } from './composer-mention-input.test-helper';

// ThreadView renders Radix Tooltips (the context-usage ring, the follow
// toggle). The app installs the single TooltipProvider at its root (main.tsx),
// so mount tests must supply one or Radix throws "`Tooltip` must be used
// within `TooltipProvider`".
const render = (ui: Parameters<typeof rtlRender>[0]) => rtlRender(ui, { wrapper: TooltipProvider });

let model: ThreadRenderModel | null = null;
/**
 * The subscribed thread's store entry. `lastSeq` is how far the client has
 * folded the server's log and `replayThroughSeq` is the upper bound of the
 * replay the subscription announced, so a transcript still coming out of
 * history is one whose `lastSeq` has not reached that bound yet.
 */
let threadState = {
  info: undefined,
  events: [] as unknown[],
  lastSeq: 5,
  replayThroughSeq: 5,
};
const respondPermission = vi.fn((_threadId: string, _requestId: string, _outcome: unknown) => {});
const setConfigOption = vi.fn(
  (_threadId: string, _configId: string, _value: string | boolean) => {},
);
const setMode = vi.fn((_threadId: string, _modeId: string) => {});
const prompt = vi.fn((_threadId: string, _content: string) => {});
const steer = vi.fn((_threadId: string, _content: string) => {});
/** What the mocked `editQueued` hands back — a rejection stands in for the
 *  server refusing an entry that already dispatched. */
let editQueuedResult: Promise<void> = Promise.resolve();
const editQueued = vi.fn((_threadId: string, _id: string, _content: string) => editQueuedResult);
const holdQueued = vi.fn((_threadId: string, _id: string, _held: boolean) => {});
const removeQueued = vi.fn((_threadId: string, _id: string) => {});
const toastError = vi.fn((_message: string) => {});
const cancel = vi.fn((_threadId: string) => {});
const retryThread = vi.fn(async (_threadId: string) => {});
/** What the mocked `authenticateThread` hands back — a rejection stands in for
 *  the agent refusing the sign-in. */
let authenticateResult: Promise<void> = Promise.resolve();
const authenticateThread = vi.fn((_threadId: string, _methodId: string) => authenticateResult);

vi.doMock('@/lib/acp/thread-client', () => ({
  getAgentThreadClient: () => ({
    respondPermission,
    respondRuntimeConsent: () => {},
    cancel,
    prompt,
    steer,
    editQueued,
    holdQueued,
    removeQueued,
    setMode,
    setConfigOption,
    closeThread: () => {},
    createThread: async () => {
      throw new Error('unused');
    },
    resumeThread: async () => {
      throw new Error('unused');
    },
    retryThread,
    authenticateThread,
  }),
  ThreadResumeError: class ThreadResumeError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  useAgentThread: () => threadState,
  useAgentThreadModel: () => model,
}));

vi.doMock('sonner', () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn() },
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ systemProvider: null }),
}));

vi.doMock('@/lib/use-workspace', () => ({
  useWorkspace: () => null,
}));

// Markdown rendering is covered by AgentMarkdown.dom.test.tsx; keep this
// suite off the streamdown pipeline.
vi.doMock('@/components/acp/AgentMarkdown', () => ({
  // Marked so a test can tell WHICH bubbles route through the renderer. Real
  // markdown output is AgentMarkdown.dom.test.tsx's subject, not this file's.
  AgentMarkdown: ({ text }: { text: string }) => <div data-testid="rendered-markdown">{text}</div>,
}));

// The composer's rich input, doubled as a textarea (jsdom can't type into a
// ProseMirror contentEditable) — see the helper's header for contract parity.
vi.doMock('@/editor/ComposerMentionInput', () => ({
  ComposerMentionInput: MockComposerMentionInput,
}));

const { ThreadView } = await import('./ThreadView');
// Not mocked — the settings popover writes real remembered picks through it.
const { agentSettingsKey, getRememberedAgentConfig, getRememberedAgentMode } = await import(
  '@/lib/acp/agent-settings-store'
);

function makeInfo(overrides?: Partial<ThreadInfo>): ThreadInfo {
  return {
    threadId: 'thread-1',
    agent: { id: 'claude', name: 'Claude Agent', source: 'registry' },
    title: 'Test thread',
    status: 'running',
    createdAt: 1,
    lastActivityAt: 2,
    lastSeq: 5,
    archived: false,
    ...overrides,
  };
}

function makeModel(overrides?: Partial<ThreadRenderModel>): ThreadRenderModel {
  return {
    items: [],
    plan: [],
    turnActive: true,
    tokenUsage: null,
    terminals: {},
    permissionsByToolCall: {},
    ...overrides,
  };
}

function toolCall(overrides?: Partial<Extract<RenderedItem, { kind: 'tool_call' }>>) {
  return {
    kind: 'tool_call' as const,
    toolCallId: 'c1',
    title: 'Run tests',
    toolKind: 'execute',
    status: 'in_progress' as const,
    diffs: [],
    terminalIds: [],
    content: [],
    locations: [],
    rawInput: undefined,
    ...overrides,
  };
}

function permission(overrides?: Partial<Extract<RenderedItem, { kind: 'permission' }>>) {
  return {
    kind: 'permission' as const,
    requestId: 'r1',
    title: 'Run npm test?',
    toolKind: 'execute',
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
    resolved: null,
    toolCallId: null,
    mergedIntoToolCall: false,
    ...overrides,
  };
}

/**
 * Tool-call bodies are collapsed by default (failures excepted), so any test
 * asserting on body content has to open the card first.
 */
async function openToolCall(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /Run tests/ }));
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  // No-op when timers are already real; makes cleanup unconditional even if a
  // test using fake timers fails before its own teardown would run.
  vi.useRealTimers();
  respondPermission.mockClear();
  setConfigOption.mockClear();
  setMode.mockClear();
  prompt.mockClear();
  steer.mockClear();
  editQueued.mockClear();
  editQueuedResult = Promise.resolve();
  holdQueued.mockClear();
  removeQueued.mockClear();
  toastError.mockClear();
  cancel.mockClear();
  retryThread.mockClear();
  authenticateThread.mockClear();
  authenticateResult = Promise.resolve();
  model = null;
  threadState = { info: undefined, events: [], lastSeq: 5, replayThroughSeq: 5 };
});

describe('ThreadView agent settings', () => {
  test('groups agent-advertised selectors and booleans into one settings menu', async () => {
    render(
      <ThreadView
        info={makeInfo({
          status: 'ready',
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'sonnet',
              options: [
                { value: 'sonnet', name: 'Sonnet' },
                { value: 'opus', name: 'Opus' },
              ],
            },
            {
              id: 'effort',
              name: 'Reasoning effort',
              category: 'thought_level',
              type: 'select',
              currentValue: 'medium',
              options: [
                { value: 'medium', name: 'Medium' },
                { value: 'high', name: 'High' },
              ],
            },
            {
              id: 'fast',
              name: 'Fast mode',
              category: 'model_config',
              type: 'boolean',
              currentValue: false,
            },
          ],
        })}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Agent settings' });
    const follow = screen.getByRole('button', { name: "Follow the agent's edits" });
    expect(screen.queryByTestId('agent-thread-agent-name')).toBeNull();
    expect(trigger.textContent).toContain('Sonnet');
    // The settings trigger now lives in the composer's bottom bar, after the
    // header's follow toggle in document order.
    expect(follow.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The menu (and its submenu rows) mount only once the menu is opened.
    expect(screen.queryByTestId('agent-thread-config-model')).toBeNull();

    await userEvent.click(trigger);
    // Each multi-value select is a submenu row summarizing its current value
    // (testids key off option.id); the boolean is an inline menuitemcheckbox.
    const modelRow = screen.getByTestId('agent-thread-config-model');
    expect(modelRow.textContent).toContain('Sonnet');
    const effortRow = screen.getByTestId('agent-thread-config-effort');
    expect(effortRow.textContent).toContain('Medium');

    // Fast mode is an inline checkbox row — clicking it toggles (menu stays open).
    const fastRow = screen.getByTestId('agent-thread-config-fast');
    expect(fastRow.textContent).toContain('Fast mode');
    expect(fastRow.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(fastRow);
    expect(setConfigOption).toHaveBeenCalledWith('thread-1', 'fast', true);

    // Open the Model submenu and pick Opus.
    await userEvent.click(modelRow);
    await userEvent.click(await screen.findByTestId('agent-thread-config-option-opus'));
    expect(setConfigOption).toHaveBeenCalledWith('thread-1', 'model', 'opus');
  });

  test('a pick lands on a real pointer press, not just a synthetic click', async () => {
    // The settings trigger lives inside the composer card, and that card's
    // `mousedown` handler focuses the textarea when a press lands on its
    // whitespace. React portals bubble synthetic events along the REACT tree,
    // so presses inside the portaled menu reach that handler too. It used to
    // claim them: the submenu closed, focus jumped to the composer, and the
    // pick never reached the agent. Only a full pointer sequence shows it — a
    // bare `fireEvent.click` dispatches no `mousedown` at all.
    render(
      <ThreadView
        info={makeInfo({
          status: 'ready',
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'sonnet',
              options: [
                { value: 'sonnet', name: 'Sonnet' },
                { value: 'opus', name: 'Opus' },
              ],
            },
          ],
        })}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Agent settings' }));
    await userEvent.click(screen.getByTestId('agent-thread-config-model'));
    await userEvent.click(await screen.findByTestId('agent-thread-config-option-opus'));

    expect(setConfigOption).toHaveBeenCalledWith('thread-1', 'model', 'opus');
    expect(document.activeElement).not.toBe(screen.getByTestId('agent-thread-composer'));
  });

  test('an archived thread keeps the menu usable and says when a pick lands', async () => {
    // The server records a pick against an archived thread and the resume
    // applies it. A pick that sticks in the menu but changes nothing until the
    // conversation wakes is indistinguishable from a menu that silently failed,
    // so the row that explains it is part of the behaviour, not decoration.
    render(
      <ThreadView
        info={makeInfo({
          status: 'exited',
          archived: true,
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'sonnet',
              options: [
                { value: 'sonnet', name: 'Sonnet' },
                { value: 'opus', name: 'Opus' },
              ],
            },
          ],
        })}
      />,
    );

    // The caveat rides the trigger's accessible name too. A menu label is a
    // bare div outside both the roving-focus collection and the menu's
    // accessible name, so on its own it never reaches a screen reader — the
    // one audience the "did my pick do anything?" confusion hits hardest.
    const trigger = screen.getByRole('button', { name: /Agent settings/ });
    expect(trigger.getAttribute('aria-label')).toMatch(/pick this conversation back up/);

    await userEvent.click(trigger);
    expect(screen.getByTestId('agent-thread-settings-archived-hint')).toBeTruthy();

    await userEvent.click(screen.getByTestId('agent-thread-config-model'));
    await userEvent.click(await screen.findByTestId('agent-thread-config-option-opus'));
    expect(setConfigOption).toHaveBeenCalledWith('thread-1', 'model', 'opus');
  });

  test('a live thread carries no archived hint', async () => {
    render(
      <ThreadView
        info={makeInfo({
          status: 'ready',
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'sonnet',
              options: [
                { value: 'sonnet', name: 'Sonnet' },
                { value: 'opus', name: 'Opus' },
              ],
            },
          ],
        })}
      />,
    );

    // Both channels, not just the visible one: an inverted archived check would
    // otherwise announce the caveat on every live thread and still pass here.
    const trigger = screen.getByRole('button', { name: 'Agent settings' });
    expect(trigger.getAttribute('aria-label')).not.toMatch(/pick this conversation back up/);
    await userEvent.click(trigger);
    expect(screen.queryByTestId('agent-thread-settings-archived-hint')).toBeNull();
  });

  test('remembers every pick for this agent, modes included', async () => {
    const key = agentSettingsKey({ source: 'registry', id: 'claude' });
    render(
      <ThreadView
        info={makeInfo({
          status: 'ready',
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'sonnet',
              options: [
                { value: 'sonnet', name: 'Sonnet' },
                { value: 'opus', name: 'Opus' },
              ],
            },
            {
              id: 'permission',
              name: 'Permission mode',
              category: 'mode',
              type: 'select',
              currentValue: 'default',
              options: [
                { value: 'default', name: 'Default' },
                { value: 'bypass', name: 'Bypass permissions' },
              ],
            },
          ],
        })}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Agent settings' }));

    // A model pick is remembered, so the next thread with this agent opens on it.
    await userEvent.click(screen.getByTestId('agent-thread-config-model'));
    await userEvent.click(await screen.findByTestId('agent-thread-config-option-opus'));
    expect(setConfigOption).toHaveBeenCalledWith('thread-1', 'model', 'opus');
    expect(getRememberedAgentConfig(key)).toEqual({ model: 'opus' });

    // A mode advertised as a config option is remembered through that same
    // path — no special case. Its permissiveness is surfaced by the accent, not
    // by declining to remember it. (Picking a select value closes the menu, so
    // reopen it.)
    await userEvent.click(screen.getByRole('button', { name: 'Agent settings' }));
    await userEvent.click(screen.getByTestId('agent-thread-config-permission'));
    await userEvent.click(await screen.findByTestId('agent-thread-config-option-bypass'));
    expect(setConfigOption).toHaveBeenCalledWith('thread-1', 'permission', 'bypass');
    expect(getRememberedAgentConfig(key)).toEqual({ model: 'opus', permission: 'bypass' });
  });
});

describe('ThreadView permissive-mode accent', () => {
  /** A ready thread sitting on `currentValue`. */
  const modeInfo = (currentValue: string) =>
    makeInfo({
      status: 'ready',
      configOptions: [
        {
          id: 'permission',
          name: 'Permission mode',
          category: 'mode',
          type: 'select',
          currentValue,
          options: [
            { value: 'default', name: 'Default' },
            { value: 'bypassPermissions', name: 'Bypass permissions' },
          ],
        },
      ],
    });

  test('an ordinary mode carries no accent', () => {
    render(<ThreadView info={modeInfo('default')} />);
    expect(screen.queryByTestId('agent-thread-mode-accent')).toBeNull();
  });

  test('a mode that lets the agent act unprompted is marked, and says so', () => {
    render(<ThreadView info={modeInfo('bypassPermissions')} />);
    expect(screen.queryByTestId('agent-thread-mode-accent')).not.toBeNull();
    // The warning must name what it is warning about, not just glow.
    expect(
      screen.getByRole('button', {
        name: /Bypass permissions lets Claude Agent act without asking/,
      }),
    ).toBeDefined();
  });

  test('marks a permissive mode on the legacy modes surface too', () => {
    render(
      <ThreadView
        info={makeInfo({
          status: 'ready',
          modes: {
            currentModeId: 'yolo',
            availableModes: [
              { id: 'default', name: 'Default' },
              { id: 'yolo', name: 'YOLO' },
            ],
          },
        })}
      />,
    );
    expect(screen.queryByTestId('agent-thread-mode-accent')).not.toBeNull();
  });

  test('the accent tracks the live mode, restored or hand-picked alike', async () => {
    const { rerender } = render(<ThreadView info={modeInfo('default')} />);
    expect(screen.queryByTestId('agent-thread-mode-accent')).toBeNull();
    // Whatever moved the thread into a permissive mode — a pick, or a restore
    // applied before turn 1 — the accent follows the mode the agent reports.
    rerender(<ThreadView info={modeInfo('bypassPermissions')} />);
    expect(screen.queryByTestId('agent-thread-mode-accent')).not.toBeNull();
    rerender(<ThreadView info={modeInfo('default')} />);
    expect(screen.queryByTestId('agent-thread-mode-accent')).toBeNull();
  });
});

describe('ThreadView agent settings (modes)', () => {
  test('includes the legacy ACP mode selector when no mode config option is advertised', async () => {
    render(
      <ThreadView
        info={makeInfo({
          status: 'ready',
          modes: {
            currentModeId: 'code',
            availableModes: [
              { id: 'ask', name: 'Ask' },
              { id: 'code', name: 'Code' },
            ],
          },
        })}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Agent settings' }));
    // Legacy modes render as an "Agent mode" submenu (synthetic id 'legacy-mode');
    // open it and pick Ask.
    await userEvent.click(screen.getByTestId('agent-thread-config-legacy-mode'));
    await userEvent.click(await screen.findByTestId('agent-thread-config-option-ask'));
    expect(setMode).toHaveBeenCalledWith('thread-1', 'ask');
    // The legacy surface has no config option to ride, so it persists under its
    // own key — but it persists just the same.
    expect(getRememberedAgentMode(agentSettingsKey({ source: 'registry', id: 'claude' }))).toBe(
      'ask',
    );
  });

  test('a permissive legacy mode persists like any other — it is flagged, not withheld', async () => {
    render(
      <ThreadView
        info={makeInfo({
          status: 'ready',
          modes: {
            currentModeId: 'default',
            availableModes: [
              { id: 'default', name: 'Default' },
              { id: 'yolo', name: 'YOLO' },
            ],
          },
        })}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Agent settings' }));
    await userEvent.click(screen.getByTestId('agent-thread-config-legacy-mode'));
    await userEvent.click(await screen.findByTestId('agent-thread-config-option-yolo'));
    expect(setMode).toHaveBeenCalledWith('thread-1', 'yolo');
    // Guards against a relapse into gating persistence on permissiveness: the
    // accent is what makes a permissive mode legible, not refusing to keep it.
    expect(getRememberedAgentMode(agentSettingsKey({ source: 'registry', id: 'claude' }))).toBe(
      'yolo',
    );
  });
});

describe('ThreadView agent settings (disable, not hide)', () => {
  test('an agent with nothing to configure keeps the trigger, disabled with the reason', () => {
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    const trigger = screen.getByTestId('agent-thread-settings');
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(trigger.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText("Claude Agent doesn't offer any settings to adjust")).toBeTruthy();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('agent-thread-settings-popover')).toBeNull();
  });

  test("before the session settles the reason says 'not yet', not 'none'", () => {
    render(<ThreadView info={makeInfo({ status: 'spawning' })} />);
    const trigger = screen.getByTestId('agent-thread-settings');
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText("Claude Agent hasn't reported its settings yet")).toBeTruthy();
  });

  test("an exited thread that never advertised settings reads 'none', not 'not yet'", () => {
    // The session ran to completion — "hasn't reported yet" would imply an
    // answer is still coming.
    render(<ThreadView info={makeInfo({ status: 'exited' })} />);
    expect(screen.getByText("Claude Agent doesn't offer any settings to adjust")).toBeTruthy();
  });
});

describe('ThreadView permission posture badge', () => {
  test('a verified autonomous agent warns that prompts cannot be added', () => {
    render(
      <ThreadView
        info={makeInfo({ agent: { id: 'pi-acp', name: 'pi ACP', source: 'registry' } })}
      />,
    );
    const badge = screen.getByTestId('agent-thread-posture');
    expect(badge.closest('[role="img"]')?.getAttribute('aria-label')).toContain(
      'acts without asking',
    );
  });

  test('every milder posture renders no badge — those signals live elsewhere', () => {
    // Asks-first (Claude): the permission prompts themselves are the signal.
    const { unmount: unmountAsks } = render(
      <ThreadView
        info={makeInfo({ agent: { id: 'claude-acp', name: 'Claude Agent', source: 'registry' } })}
      />,
    );
    expect(screen.queryByTestId('agent-thread-posture')).toBeNull();
    unmountAsks();

    // Self-managed (declared modes): the settings trigger names the mode and
    // the permissive-mode accent flags the dangerous ones.
    const { unmount: unmountModes } = render(
      <ThreadView
        info={makeInfo({
          agent: { id: 'someagent', name: 'Some Agent', source: 'registry' },
          modes: {
            currentModeId: 'agent',
            availableModes: [
              { id: 'agent', name: 'Agent (full access)' },
              { id: 'plan', name: 'Plan' },
            ],
          },
        })}
      />,
    );
    expect(screen.queryByTestId('agent-thread-posture')).toBeNull();
    unmountModes();

    // Unverified with no modes: "can't tell" must never render as the
    // autonomous warning.
    render(<ThreadView info={makeInfo()} />);
    expect(screen.queryByTestId('agent-thread-posture')).toBeNull();
  });
});

describe('ThreadView terminal card', () => {
  const terminal = (overrides?: Partial<RenderedTerminal>): RenderedTerminal => ({
    terminalId: 't1',
    command: 'npm',
    args: ['test'],
    output: 'ok 12 tests\n',
    truncated: false,
    exit: { exitCode: 0, signal: null },
    ...overrides,
  });

  test('renders command line, output, and a neutral exit-0 badge', async () => {
    model = makeModel({
      items: [toolCall({ terminalIds: ['t1'], status: 'completed' })],
      terminals: { t1: terminal() },
      turnActive: false,
    });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    // Completed cards start collapsed — expand to reach the body.
    await userEvent.click(screen.getByRole('button', { name: /Run tests/ }));
    const card = screen.getByTestId('agent-thread-terminal');
    expect(card.textContent).toContain('npm test');
    expect(card.textContent).toContain('ok 12 tests');
    expect(screen.getByTestId('agent-thread-terminal-exit').textContent).toBe('exit 0');
  });

  test('a failing command shows a destructive exit badge; ANSI is stripped', async () => {
    model = makeModel({
      items: [toolCall({ terminalIds: ['t1'] })],
      terminals: {
        t1: terminal({
          output: '\x1b[31mFAIL\x1b[0m assertion',
          exit: { exitCode: 3, signal: null },
        }),
      },
    });
    render(<ThreadView info={makeInfo()} />);
    await openToolCall();
    const badge = screen.getByTestId('agent-thread-terminal-exit');
    expect(badge.textContent).toBe('exit 3');
    const card = screen.getByTestId('agent-thread-terminal');
    expect(card.textContent).toContain('FAIL assertion');
    expect(card.textContent).not.toContain('[31m');
  });

  test('a still-running terminal shows no exit badge', async () => {
    model = makeModel({
      items: [toolCall({ terminalIds: ['t1'] })],
      terminals: { t1: terminal({ exit: null }) },
    });
    render(<ThreadView info={makeInfo()} />);
    await openToolCall();
    expect(screen.getByTestId('agent-thread-terminal').textContent).toContain('running');
    expect(screen.queryByTestId('agent-thread-terminal-exit')).toBeNull();
  });
});

describe('ThreadView inline diff', () => {
  test('unchanged lines render once as context, not as remove+add pairs', async () => {
    model = makeModel({
      items: [
        toolCall({
          status: 'in_progress',
          diffs: [{ path: 'notes.md', oldText: 'same\nold\n', newText: 'same\nnew\n' }],
        }),
      ],
    });
    render(<ThreadView info={makeInfo()} />);
    await openToolCall();
    const transcript = screen.getByTestId('agent-thread-transcript');
    const occurrences = (transcript.textContent?.match(/same/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(transcript.textContent).toContain('- old');
    expect(transcript.textContent).toContain('+ new');
  });

  test('long unchanged runs collapse into a gap row', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    model = makeModel({
      items: [
        toolCall({
          status: 'in_progress',
          diffs: [{ path: 'big.md', oldText: `${lines}\nend`, newText: `${lines}\nEND` }],
        }),
      ],
    });
    render(<ThreadView info={makeInfo()} />);
    await openToolCall();
    expect(screen.getByTestId('agent-thread-transcript').textContent).toContain('unchanged lines');
  });
});

describe('ThreadView permissions', () => {
  test('stacks three-plus options top-to-bottom with the primary grant emphasized', () => {
    model = makeModel({
      items: [
        permission({
          options: [
            {
              optionId: 'always',
              name: 'Always allow all mcp__open-knowledge__exec',
              kind: 'allow_always',
            },
            { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
        }),
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'awaiting_permission' })} />);

    const card = screen.getByTestId('agent-thread-permission');
    const stack = screen.getByTestId('agent-thread-permission-stack');
    const deny = screen.getByTestId('agent-thread-permission-deny');
    const primary = screen.getByTestId('agent-thread-permission-allow');

    // Primary allow is first in DOM order (top of stack); deny follows below.
    expect(primary.compareDocumentPosition(deny) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The escalating grant renders as a peer button, not tucked behind a chevron.
    const escalating = within(stack).getByRole('button', {
      name: 'Always allow all mcp__open-knowledge__exec',
    });
    expect(escalating).toBeDefined();

    // Only the least-privilege grant carries primary emphasis.
    expect(primary.textContent).toBe('Allow');
    expect(primary.getAttribute('data-variant')).toBe('default');
    expect(escalating.getAttribute('data-variant')).toBe('outline');
    expect(deny.getAttribute('data-variant')).toBe('outline');

    // No secondary-cluster chevron — the stack has no dropdown.
    expect(within(card).queryByTestId('agent-thread-permission-allow-more')).toBeNull();
    expect(within(card).queryByTestId('agent-thread-permission-allow-more-more')).toBeNull();
  });

  test('renders every one of four options as a full-width button — no overflow menu', async () => {
    // Claude's four-option shape: `kind` is a hint, not a key — two distinct
    // grants share `allow_always` and differ only by name.
    model = makeModel({
      items: [
        permission({
          options: [
            { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
            { optionId: 'session', name: 'Allow for This Session', kind: 'allow_always' },
            { optionId: 'forever', name: "Allow and Don't Ask Again", kind: 'allow_always' },
            { optionId: 'no', name: 'Decline', kind: 'reject_once' },
          ],
        }),
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'awaiting_permission' })} />);

    // Every option is a real peer button — no dropdown, no truncation.
    const primary = screen.getByTestId('agent-thread-permission-allow');
    const deny = screen.getByTestId('agent-thread-permission-deny');
    expect(primary.textContent).toBe('Allow');
    expect(deny.textContent).toBe('Decline');
    const session = screen.getByRole('button', { name: 'Allow for This Session' });
    const forever = screen.getByRole('button', { name: "Allow and Don't Ask Again" });
    expect(session).toBeDefined();
    expect(forever).toBeDefined();

    // Clicking a secondary allow selects its optionId directly.
    await userEvent.click(session);
    expect(respondPermission).toHaveBeenCalledWith('thread-1', 'r1', {
      kind: 'selected',
      optionId: 'session',
    });

    // Escalated allow is likewise directly actionable.
    await userEvent.click(forever);
    expect(respondPermission).toHaveBeenCalledWith('thread-1', 'r1', {
      kind: 'selected',
      optionId: 'forever',
    });
  });

  test('stacks even when the extra option is a second allow with no reject', async () => {
    // Two-allow / zero-reject shape: the row branch renders only the primary
    // grant, so without the stack the escalating grant is unreachable. And
    // the stack must still surface a refusal — the agent offered none, so we
    // synthesize a cancel-wired Deny.
    model = makeModel({
      items: [
        permission({
          options: [
            { optionId: 'once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'always', name: 'Allow for This Session', kind: 'allow_always' },
          ],
        }),
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'awaiting_permission' })} />);
    expect(screen.getByTestId('agent-thread-permission-stack')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Allow for This Session' })).toBeDefined();
    const deny = screen.getByTestId('agent-thread-permission-deny');
    expect(deny.textContent).toBe('Deny');
    await userEvent.click(deny);
    expect(respondPermission).toHaveBeenCalledWith('thread-1', 'r1', { kind: 'cancelled' });
  });

  test('stacks two reject options with no allow so the escalating refusal is reachable', () => {
    // Symmetric to the two-allow / zero-reject case: the row branch would
    // collapse denyOptions to just the primary, dropping the escalating
    // refusal. Two-reject / zero-allow enters the stack via
    // `denyOptions.length > 1` and renders both refusal buttons.
    model = makeModel({
      items: [
        permission({
          options: [
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
            { optionId: 'stop', name: 'Reject and Stop Session', kind: 'reject_always' },
          ],
        }),
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'awaiting_permission' })} />);
    expect(screen.getByTestId('agent-thread-permission-stack')).toBeDefined();
    expect(screen.getByTestId('agent-thread-permission-deny').textContent).toBe('Reject');
    expect(screen.getByRole('button', { name: 'Reject and Stop Session' })).toBeDefined();
  });

  test('clicking an offered option approves with that optionId (selected outcome)', async () => {
    model = makeModel({ items: [permission()] });
    render(<ThreadView info={makeInfo({ status: 'awaiting_permission' })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(respondPermission).toHaveBeenCalledWith('thread-1', 'r1', {
      kind: 'selected',
      optionId: 'yes',
    });
  });

  test('adds an explicit Deny when the agent offers no reject option, wired to the cancelled outcome', async () => {
    model = makeModel({ items: [permission()] });
    render(<ThreadView info={makeInfo({ status: 'awaiting_permission' })} />);
    await userEvent.click(screen.getByTestId('agent-thread-permission-deny'));
    expect(respondPermission).toHaveBeenCalledWith('thread-1', 'r1', { kind: 'cancelled' });
  });

  test("answers with the agent's own reject option rather than a second Deny", async () => {
    model = makeModel({
      items: [
        permission({
          options: [
            { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
        }),
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'awaiting_permission' })} />);
    // One refusal control, and it routes through the agent's option (selected)
    // instead of the protocol-level `cancelled` fallback.
    const deny = screen.getByTestId('agent-thread-permission-deny');
    expect(deny.textContent).toBe('Reject');
    await userEvent.click(deny);
    expect(respondPermission).toHaveBeenCalledWith('thread-1', 'r1', {
      kind: 'selected',
      optionId: 'no',
    });
  });

  test("summarizes a chosen reject option as denied, never 'Approved'", () => {
    model = makeModel({
      items: [
        permission({
          options: [
            { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
          resolved: { optionId: 'no', auto: false },
        }),
      ],
      turnActive: false,
    });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    const outcome = screen.getByTestId('agent-thread-permission-outcome');
    expect(outcome.textContent).toContain('Denied');
    expect(outcome.textContent).not.toContain('Approved');
  });

  test('an unresolved request on a dead turn renders inert (no buttons)', () => {
    model = makeModel({ items: [permission()], turnActive: false });
    render(<ThreadView info={makeInfo({ status: 'exited' })} />);
    const card = screen.getByTestId('agent-thread-permission');
    expect(card.querySelector('button')).toBeNull();
    expect(card.textContent).toContain('no longer active');
  });
});

describe('ThreadView status + usage', () => {
  test("shows 'Waiting for your approval' instead of the working spinner while parked", () => {
    model = makeModel({ items: [permission()] });
    render(<ThreadView info={makeInfo({ status: 'awaiting_permission' })} />);
    expect(screen.getByTestId('agent-thread-awaiting-permission').textContent).toContain(
      'Waiting for your approval',
    );
  });

  test('renders the context-usage ring with a percentage and compact token counts in its label', () => {
    model = makeModel({ tokenUsage: { used: 12_345, size: 200_000 } });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    const usage = screen.getByTestId('agent-thread-usage');
    const label = usage.getAttribute('aria-label') ?? '';
    expect(label).toContain('6%');
    expect(label).toContain('12k');
    expect(label).toContain('200k');
  });

  test('shows no usage ring when the agent reports usage but no context size', () => {
    // Without a size there is no fill to draw — the ring is meaningless.
    model = makeModel({ tokenUsage: { used: 500, size: undefined } });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    expect(screen.queryByTestId('agent-thread-usage')).toBeNull();
  });

  test('no ring at all until the agent reports usage', () => {
    model = makeModel();
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    expect(screen.queryByTestId('agent-thread-usage')).toBeNull();
  });
});

describe('ThreadView tool-call status', () => {
  test('a settled successful call carries no visible status chrome', () => {
    model = makeModel({
      items: [toolCall({ status: 'completed', content: ['out'] })],
      turnActive: false,
    });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    // Replayed rows never flash a check, and "done" is not painted on the row.
    expect(screen.queryByTestId('agent-thread-tool-check')).toBeNull();
    expect(screen.queryByTestId('agent-thread-tool-failed')).toBeNull();
    expect(screen.queryByTestId('agent-thread-tool-spinner')).toBeNull();
    // …but the status still reaches assistive tech.
    expect(screen.getByRole('button', { name: /Run tests/ }).textContent).toContain('done');
  });

  test('a live call spins, then flashes a check on completion', () => {
    model = makeModel({ items: [toolCall({ status: 'in_progress', content: ['out'] })] });
    const { rerender } = render(<ThreadView info={makeInfo()} />);
    expect(screen.getByTestId('agent-thread-tool-spinner')).toBeDefined();
    expect(screen.queryByTestId('agent-thread-tool-check')).toBeNull();

    model = makeModel({
      items: [toolCall({ status: 'completed', content: ['out'] })],
      turnActive: false,
    });
    rerender(<ThreadView info={makeInfo({ status: 'ready' })} />);
    expect(screen.queryByTestId('agent-thread-tool-spinner')).toBeNull();
    // Only a call that completed while mounted acknowledges the transition.
    expect(screen.getByTestId('agent-thread-tool-check')).toBeDefined();
  });

  test('a fenced output block renders without its backticks', async () => {
    model = makeModel({
      items: [toolCall({ status: 'completed', content: ['```json\n{"ok":true}\n```'] })],
      turnActive: false,
    });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    await openToolCall();
    const body = screen.getByTestId('agent-thread-tool-call').textContent ?? '';
    expect(body).toContain('{"ok":true}');
    expect(body).not.toContain('```');
  });

  test('a fence opening partway through is output, not a wrapper', async () => {
    model = makeModel({
      items: [toolCall({ status: 'completed', content: ['see:\n```\ncode\n```'] })],
      turnActive: false,
    });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    await openToolCall();
    expect(screen.getByTestId('agent-thread-tool-call').textContent).toContain('```');
  });

  test('the completion check fades out once its window elapses', async () => {
    // Without this, deleting the setTimeout would leave a check pinned to every
    // recently-completed row and the "flashes a check" test above would still pass.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    model = makeModel({ items: [toolCall({ status: 'in_progress', content: ['out'] })] });
    const { rerender } = render(<ThreadView info={makeInfo()} />);

    model = makeModel({
      items: [toolCall({ status: 'completed', content: ['out'] })],
      turnActive: false,
    });
    rerender(<ThreadView info={makeInfo({ status: 'ready' })} />);
    // `.className` on an <svg> is an SVGAnimatedString, not a string.
    expect(screen.getByTestId('agent-thread-tool-check').getAttribute('class')).toContain(
      'opacity-100',
    );

    // Past COMPLETION_CHECK_MS the element stays mounted (so the row doesn't
    // reflow) but transitions to transparent.
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByTestId('agent-thread-tool-check').getAttribute('class')).toContain(
      'opacity-0',
    );
  });

  test('a failed call keeps its badge — the exception is what gets marked', () => {
    model = makeModel({
      items: [toolCall({ status: 'failed', content: ['boom'] })],
      turnActive: false,
    });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    expect(screen.getByTestId('agent-thread-tool-failed').textContent).toBe('failed');
  });

  test('a call with nothing to reveal is not an interactive control', () => {
    model = makeModel({ items: [toolCall({ status: 'completed' })], turnActive: false });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    expect(screen.queryByRole('button', { name: /Run tests/ })).toBeNull();
    expect(screen.getByTestId('agent-thread-tool-call').textContent).toContain('Run tests');
  });

  test('an Open Knowledge call says what it did, not the name the adapter sent', () => {
    model = makeModel({
      items: [
        toolCall({
          status: 'completed',
          title: 'mcp__open-knowledge__write',
          toolKind: 'other',
          rawInput: { document: { path: 'meetings/standup.md' } },
        }),
      ],
      turnActive: false,
    });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    const row = screen.getByTestId('agent-thread-tool-call').textContent ?? '';
    expect(row).toContain('OpenKnowledge wrote to meetings/standup');
    expect(row).not.toContain('mcp__open-knowledge__write');
  });
});

describe('ThreadView permission merged into its tool call', () => {
  const gated = (resolved: { optionId: string | null; auto: boolean }) =>
    permission({ toolCallId: 'c1', mergedIntoToolCall: true, resolved });

  function modelWithGatedCall(resolved: { optionId: string | null; auto: boolean }) {
    const item = gated(resolved);
    return makeModel({
      items: [toolCall({ status: 'completed' }), item],
      permissionsByToolCall: { c1: item },
      turnActive: false,
    });
  }

  test('an approval leaves no trace — the card goes, and nothing replaces it', () => {
    model = modelWithGatedCall({ optionId: 'yes', auto: false });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    // The call ran; that it was allowed is not separately worth saying.
    expect(screen.queryByTestId('agent-thread-permission')).toBeNull();
    expect(screen.queryByTestId('agent-thread-tool-permission')).toBeNull();
  });

  test('an auto-approval leaves no trace either', () => {
    model = modelWithGatedCall({ optionId: 'yes', auto: true });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    expect(screen.queryByTestId('agent-thread-permission')).toBeNull();
    expect(screen.queryByTestId('agent-thread-tool-permission')).toBeNull();
  });

  test('a refusal marks the row in words — it changed what happened', () => {
    model = modelWithGatedCall({ optionId: null, auto: false });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    expect(screen.getByTestId('agent-thread-tool-permission').textContent).toContain('Denied');
  });

  test('a dismissed prompt marks the row too — it also did not get an answer', () => {
    // `auto: true` with no chosen option is the timeout/turn-cancel path.
    model = modelWithGatedCall({ optionId: null, auto: true });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    expect(screen.getByTestId('agent-thread-tool-permission').textContent).toContain(
      'Not answered',
    );
  });

  test('stays quiet when the failed row already says the call did not run', () => {
    // The FAILED badge and the body cover it; a third statement is noise.
    const item = gated({ optionId: null, auto: false });
    model = makeModel({
      items: [toolCall({ status: 'failed', content: ['User refused permission'] }), item],
      permissionsByToolCall: { c1: item },
      turnActive: false,
    });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    expect(screen.queryByTestId('agent-thread-tool-permission')).toBeNull();
  });

  test('drops an option name that only repeats the outcome, keeps a distinctive one', () => {
    const synonym = permission({
      toolCallId: 'c1',
      mergedIntoToolCall: true,
      options: [{ optionId: 'no', name: 'Reject', kind: 'reject_once' }],
      resolved: { optionId: 'no', auto: false },
    });
    model = makeModel({
      items: [toolCall({ status: 'completed' }), synonym],
      permissionsByToolCall: { c1: synonym },
      turnActive: false,
    });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    // "Denied — Reject" says the same word twice.
    expect(screen.getByTestId('agent-thread-tool-permission').textContent).toBe('Denied');

    cleanup();
    const distinctive = permission({
      toolCallId: 'c1',
      mergedIntoToolCall: true,
      options: [{ optionId: 'never', name: 'Always deny', kind: 'reject_always' }],
      resolved: { optionId: 'never', auto: false },
    });
    model = makeModel({
      items: [toolCall({ status: 'completed' }), distinctive],
      permissionsByToolCall: { c1: distinctive },
      turnActive: false,
    });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    // The persistence is not implied by "Denied", so it survives.
    expect(screen.getByTestId('agent-thread-tool-permission').textContent).toContain('Always deny');
  });

  test('a pending prompt keeps its card — it is the thing you act on', () => {
    const item = permission({ toolCallId: 'c1', mergedIntoToolCall: true });
    model = makeModel({
      items: [toolCall({ status: 'in_progress' }), item],
      permissionsByToolCall: { c1: item },
    });
    render(<ThreadView info={makeInfo({ status: 'awaiting_permission' })} />);
    expect(screen.getByTestId('agent-thread-permission')).toBeDefined();
    expect(screen.queryByTestId('agent-thread-tool-permission')).toBeNull();
  });

  test('an unmergeable outcome keeps the standalone card as its fallback', () => {
    // No toolCallId from the agent — the outcome must stay reachable somewhere.
    model = makeModel({
      items: [permission({ resolved: { optionId: 'yes', auto: false } })],
      turnActive: false,
    });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    expect(screen.getByTestId('agent-thread-permission-outcome').textContent).toContain('Approved');
  });
});

describe('ThreadView tool-call collapse', () => {
  test('stays collapsed through a live run — no open-then-fold flicker', async () => {
    model = makeModel({
      items: [toolCall({ status: 'in_progress', content: ['running output'] })],
    });
    const { rerender } = render(<ThreadView info={makeInfo()} />);
    expect(screen.queryByText('running output')).toBeNull();

    // Completing changes nothing about the body: there is no fold to jank.
    model = makeModel({
      items: [toolCall({ status: 'completed', content: ['running output'] })],
      turnActive: false,
    });
    rerender(<ThreadView info={makeInfo({ status: 'ready' })} />);
    expect(screen.queryByText('running output')).toBeNull();
    expect(screen.getByRole('button', { name: /Run tests/ }).getAttribute('aria-expanded')).toBe(
      'false',
    );

    // Still openable on demand.
    await openToolCall();
    expect(screen.getByText('running output')).toBeDefined();
  });

  test('opens a call that fails while you watch, and leaves replayed ones closed', () => {
    model = makeModel({ items: [toolCall({ status: 'in_progress', content: ['boom'] })] });
    const { rerender } = render(<ThreadView info={makeInfo()} />);
    expect(screen.queryByText('boom')).toBeNull();

    model = makeModel({
      items: [toolCall({ status: 'failed', content: ['boom'] })],
      turnActive: false,
    });
    rerender(<ThreadView info={makeInfo({ status: 'ready' })} />);
    // An error is the one body worth showing unasked.
    expect(screen.getByText('boom')).toBeDefined();

    // A failure already on screen at mount (replay) opens too — but that is the
    // mount state, not a transition, so it never animates a hundred rows at once.
    cleanup();
    model = makeModel({
      items: [toolCall({ status: 'failed', content: ['old failure'] })],
      turnActive: false,
    });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    expect(screen.getByText('old failure')).toBeDefined();
  });

  test('keeps a card open when the user expanded it before completion', async () => {
    // The regression this guards: a fold-on-completion rule wiping a manual
    // toggle mid-run. So the expand has to happen while the call is still
    // in_progress, and the completion has to arrive as a live transition.
    model = makeModel({
      items: [toolCall({ status: 'in_progress', content: ['review me'] })],
    });
    const { rerender } = render(<ThreadView info={makeInfo()} />);
    expect(screen.queryByText('review me')).toBeNull();
    await openToolCall();
    expect(screen.getByText('review me')).toBeDefined();

    model = makeModel({
      items: [toolCall({ status: 'completed', content: ['review me'] })],
      turnActive: false,
    });
    rerender(<ThreadView info={makeInfo({ status: 'ready' })} />);
    expect(screen.getByText('review me')).toBeDefined();
    expect(screen.getByRole('button', { name: /Run tests/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });
});

describe('ThreadView raw input', () => {
  test('collapses raw tool input by default and reveals it on request', async () => {
    model = makeModel({
      items: [toolCall({ rawInput: { docName: 'notes/today', position: 'append' } })],
    });
    render(<ThreadView info={makeInfo()} />);
    await openToolCall();
    const block = screen.getByTestId('agent-thread-tool-raw-input');
    const trigger = screen.getByRole('button', { name: 'Input' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(block.textContent).not.toContain('notes/today');

    await userEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(block.textContent).toContain('notes/today');
  });

  test('an empty rawInput object renders no input block', () => {
    model = makeModel({ items: [toolCall({ rawInput: {} })] });
    render(<ThreadView info={makeInfo()} />);
    expect(screen.queryByTestId('agent-thread-tool-raw-input')).toBeNull();
  });
});

describe('ThreadView message queue', () => {
  test('mid-turn the action slot holds Stop until a draft exists, then yields to Send', () => {
    model = makeModel({ turnActive: true });
    render(<ThreadView info={makeInfo({ status: 'running' })} />);

    // Empty draft: Stop owns the slot outright — no competing Send button.
    expect(screen.getByTestId('agent-thread-cancel')).toBeTruthy();
    expect(screen.queryByTestId('agent-thread-send')).toBeNull();

    fireEvent.change(screen.getByTestId('agent-thread-composer'), {
      target: { value: 'queued while running' },
    });

    expect(screen.queryByTestId('agent-thread-cancel')).toBeNull();
    const send = screen.getByTestId('agent-thread-send');
    expect(send.getAttribute('aria-label')).toBe('Queue message');
    expect((send as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(send);
    expect(prompt).toHaveBeenCalledWith('thread-1', 'queued while running', undefined);
  });

  test('Escape cancels the turn while a draft holds the action slot', () => {
    model = makeModel({ turnActive: true });
    render(<ThreadView info={makeInfo({ status: 'running' })} />);

    const composer = screen.getByTestId('agent-thread-composer');
    fireEvent.change(composer, { target: { value: 'typed mid-turn' } });
    // Stop is gone, so this is the only remaining way to cancel.
    expect(screen.queryByTestId('agent-thread-cancel')).toBeNull();

    fireEvent.keyDown(composer, { key: 'Escape' });
    expect(cancel).toHaveBeenCalledWith('thread-1');
    // The draft survives the cancel — it's still queueable against the next turn.
    expect((composer as HTMLTextAreaElement).value).toBe('typed mid-turn');
  });

  test('a pending cancel keeps the Stopping spinner even as the user types', () => {
    model = makeModel({ turnActive: true });
    render(<ThreadView info={makeInfo({ status: 'running' })} />);

    fireEvent.click(screen.getByTestId('agent-thread-cancel'));
    fireEvent.change(screen.getByTestId('agent-thread-composer'), {
      target: { value: 'typed while stopping' },
    });

    const stopping = screen.getByTestId('agent-thread-cancel');
    expect(stopping.getAttribute('aria-label')).toBe('Stopping');
    expect((stopping as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('agent-thread-send')).toBeNull();
  });

  test('outside a turn the slot is Send, disabled only by an empty draft', () => {
    model = makeModel({ turnActive: false });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);

    expect(screen.queryByTestId('agent-thread-cancel')).toBeNull();
    const send = screen.getByTestId('agent-thread-send');
    expect(send.getAttribute('aria-label')).toBe('Send');
    expect((send as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('agent-thread-composer'), {
      target: { value: 'idle send' },
    });
    expect((screen.getByTestId('agent-thread-send') as HTMLButtonElement).disabled).toBe(false);
  });

  test('Escape stays scoped to the composer and does not cancel from the transcript', () => {
    model = makeModel({ turnActive: true });
    render(<ThreadView info={makeInfo({ status: 'running' })} />);

    fireEvent.change(screen.getByTestId('agent-thread-composer'), {
      target: { value: 'typed, then clicked away' },
    });

    fireEvent.keyDown(screen.getByTestId('agent-thread-transcript'), { key: 'Escape' });
    expect(cancel).not.toHaveBeenCalled();

    // Escape is dismiss-shaped, so a panel-wide binding would let a stray press
    // kill a running turn. The accepted cost is this state: a draft hides Stop,
    // and cancelling means clicking back into the composer or clearing the draft.
    // Pinned so widening the scope is a deliberate change, not an accident.
    fireEvent.keyDown(screen.getByTestId('agent-thread-composer'), { key: 'Escape' });
    expect(cancel).toHaveBeenCalledWith('thread-1');
  });

  test('the composer carries no add-context control', () => {
    model = makeModel({ turnActive: true });
    render(<ThreadView info={makeInfo({ status: 'running' })} />);

    // The `+` opened a one-row menu whose only row was inert without a loaded
    // comment queue, and the queue panel's own Send already dispatches to this
    // thread. Pinned so it does not drift back in as decoration.
    expect(screen.queryByTestId('composer-add-context')).toBeNull();
  });

  test('Escape cancels with an empty draft too, while Stop is also on screen', () => {
    model = makeModel({ turnActive: true });
    render(<ThreadView info={makeInfo({ status: 'running' })} />);

    expect(screen.getByTestId('agent-thread-cancel')).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('agent-thread-composer'), { key: 'Escape' });
    expect(cancel).toHaveBeenCalledWith('thread-1');
  });

  test('Escape is a no-op while a cancel is already pending', () => {
    model = makeModel({ turnActive: true });
    render(<ThreadView info={makeInfo({ status: 'running' })} />);

    fireEvent.click(screen.getByTestId('agent-thread-cancel'));
    expect(cancel).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByTestId('agent-thread-composer'), { key: 'Escape' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test('Escape outside a turn does not fire a cancel', () => {
    model = makeModel({ turnActive: false });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);

    const composer = screen.getByTestId('agent-thread-composer');
    fireEvent.change(composer, { target: { value: 'idle draft' } });
    fireEvent.keyDown(composer, { key: 'Escape' });

    expect(cancel).not.toHaveBeenCalled();
  });

  test('Stop advertises the Escape shortcut, so it is learned before it is needed', async () => {
    const user = userEvent.setup();
    model = makeModel({ turnActive: true });
    render(<ThreadView info={makeInfo({ status: 'running' })} />);

    await user.hover(screen.getByTestId('agent-thread-cancel'));

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Esc');
  });

  test('Escape in the queued-message editor exits editing without cancelling the turn', () => {
    model = makeModel({ turnActive: true });
    render(
      <ThreadView
        info={makeInfo({
          status: 'running',
          queue: [{ id: 'q1', content: 'original text', ts: 1 }],
        })}
      />,
    );

    fireEvent.click(screen.getByTestId('agent-thread-queued-edit'));
    fireEvent.keyDown(screen.getByTestId('agent-thread-queued-input'), { key: 'Escape' });

    expect(screen.queryByTestId('agent-thread-queued-input')).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
  });

  test('queued messages render between transcript and composer with a remove control', () => {
    model = makeModel({ turnActive: true });
    render(
      <ThreadView
        info={makeInfo({
          status: 'running',
          queue: [
            { id: 'q1', content: 'first queued', ts: 1 },
            { id: 'q2', content: 'second queued', ts: 2 },
          ],
        })}
      />,
    );

    const rows = screen.getAllByTestId('agent-thread-queued');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('first queued');
    expect(rows[1]?.textContent).toContain('second queued');

    const firstRow = rows[0];
    if (firstRow === undefined) throw new Error('missing queue row');
    fireEvent.click(within(firstRow).getByTestId('agent-thread-queued-remove'));
    expect(removeQueued).toHaveBeenCalledWith('thread-1', 'q1');
  });

  test('in-place edit opens with the current content and saves on Enter', () => {
    model = makeModel({ turnActive: true });
    render(
      <ThreadView
        info={makeInfo({
          status: 'running',
          queue: [{ id: 'q1', content: 'original text', ts: 1 }],
        })}
      />,
    );

    fireEvent.click(screen.getByTestId('agent-thread-queued-edit'));
    const input = screen.getByTestId('agent-thread-queued-input') as HTMLTextAreaElement;
    expect(input.value).toBe('original text');

    fireEvent.change(input, { target: { value: 'sharper text' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(editQueued).toHaveBeenCalledWith('thread-1', 'q1', 'sharper text');
    // The row returned to display mode.
    expect(screen.queryByTestId('agent-thread-queued-input')).toBeNull();
    expect(screen.getByTestId('agent-thread-queued')).toBeTruthy();
  });

  test('Escape abandons the edit without sending anything', () => {
    model = makeModel({ turnActive: true });
    render(
      <ThreadView
        info={makeInfo({
          status: 'running',
          queue: [{ id: 'q1', content: 'keep me', ts: 1 }],
        })}
      />,
    );

    fireEvent.click(screen.getByTestId('agent-thread-queued-edit'));
    const input = screen.getByTestId('agent-thread-queued-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(editQueued).not.toHaveBeenCalled();
    expect(screen.queryByTestId('agent-thread-queued-input')).toBeNull();
    expect(screen.getByTestId('agent-thread-queued').textContent).toContain('keep me');
  });
});

describe('ThreadView thought collapse', () => {
  const thought = {
    kind: 'message' as const,
    role: 'thought' as const,
    text: 'First thought line\nLast thought line',
    messageId: 'default',
  };

  test('collapsed by default with a tail-line preview while streaming', () => {
    model = makeModel({ turnActive: true, items: [thought] });
    render(<ThreadView info={makeInfo({ status: 'running' })} />);

    const toggle = screen.getByTestId('agent-thread-thought-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // Streaming shows the tail line (it moves), not the head.
    expect(toggle.textContent).toContain('Last thought line');
    expect(toggle.textContent).not.toContain('First thought line');
    // The full body is not mounted while collapsed.
    expect(screen.getByTestId('agent-thread-thought').textContent).not.toContain(
      'First thought line',
    );
  });

  test('settled preview is the head line; expanding reveals the full text', async () => {
    model = makeModel({ turnActive: false, items: [thought] });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);

    const toggle = screen.getByTestId('agent-thread-thought-toggle');
    expect(toggle.textContent).toContain('First thought line');

    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const block = screen.getByTestId('agent-thread-thought');
    expect(block.textContent).toContain('First thought line');
    expect(block.textContent).toContain('Last thought line');
  });
});

describe('ThreadView config value hints', () => {
  test("a bare adapter 'Default' resolves via the hint table on the row and in the flyout", async () => {
    render(
      <ThreadView
        info={makeInfo({
          status: 'ready',
          agent: { id: 'claude-acp', name: 'Claude Agent', source: 'registry' },
          configOptions: [
            {
              id: 'effort',
              name: 'Effort',
              category: 'thought_level',
              type: 'select',
              currentValue: 'default',
              // Mirrors the claude-acp adapter: no description on any entry.
              options: [
                { value: 'default', name: 'Default' },
                { value: 'high', name: 'High' },
              ],
            },
          ],
        })}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Agent settings' }));
    // The collapsed row summarizes what the default resolves to, not "Default".
    const effortRow = screen.getByTestId('agent-thread-config-effort');
    expect(effortRow.textContent).toContain("Model's default effort");

    // In the flyout the hint is the secondary line under the adapter's name.
    await userEvent.click(effortRow);
    const entry = await screen.findByTestId('agent-thread-config-option-default');
    expect(entry.textContent).toContain('Default');
    expect(entry.textContent).toContain("Model's default effort");
  });

  test("a default sharing a sibling's description resolves to the sibling's name", async () => {
    render(
      <ThreadView
        info={makeInfo({
          status: 'ready',
          agent: { id: 'claude-acp', name: 'Claude Agent', source: 'registry' },
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'default',
              // Mirrors the claude-acp adapter: the default entry carries the
              // exact description of the model it resolves to.
              options: [
                {
                  value: 'default',
                  name: 'Default (recommended)',
                  description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
                },
                {
                  value: 'opus[1m]',
                  name: 'Opus (1M context)',
                  description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
                },
                { value: 'sonnet', name: 'Sonnet', description: 'Sonnet 5 · Efficient' },
              ],
            },
          ],
        })}
      />,
    );

    // The composer trigger names the resolved model, with default demoted to
    // the secondary hint.
    const trigger = screen.getByRole('button', { name: 'Agent settings' });
    expect(trigger.textContent).toContain('Opus (1M context) · default');

    await userEvent.click(trigger);
    const modelRow = screen.getByTestId('agent-thread-config-model');
    expect(modelRow.textContent).toContain('Opus (1M context) · default');
  });
});

describe('ThreadView queue rescue on Stop', () => {
  test('Stop folds every queued message back into the composer', () => {
    model = makeModel({ turnActive: true });
    render(
      <ThreadView
        info={makeInfo({
          status: 'running',
          queue: [
            { id: 'q1', content: 'first correction', ts: 1 },
            { id: 'q2', content: 'second correction', ts: 2 },
          ],
        })}
      />,
    );

    fireEvent.click(screen.getByTestId('agent-thread-cancel'));

    expect(cancel).toHaveBeenCalledWith('thread-1');
    // The server drops the queue on cancel, so the words only survive here.
    const composer = screen.getByTestId('agent-thread-composer') as HTMLTextAreaElement;
    expect(composer.value).toBe('first correction\n\nsecond correction');
  });

  test('the Escape cancel path rescues the queue too, appended to the draft', () => {
    model = makeModel({ turnActive: true });
    render(
      <ThreadView
        info={makeInfo({
          status: 'running',
          queue: [{ id: 'q1', content: 'queued fix', ts: 1 }],
        })}
      />,
    );

    const composer = screen.getByTestId('agent-thread-composer') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'already typing' } });
    fireEvent.keyDown(composer, { key: 'Escape' });

    expect(cancel).toHaveBeenCalledWith('thread-1');
    expect(composer.value).toBe('already typing\n\nqueued fix');
  });

  test('an empty queue leaves the draft exactly as typed', () => {
    model = makeModel({ turnActive: true });
    render(<ThreadView info={makeInfo({ status: 'running' })} />);

    const composer = screen.getByTestId('agent-thread-composer') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'just this' } });
    fireEvent.keyDown(composer, { key: 'Escape' });

    expect(composer.value).toBe('just this');
  });
});

describe('ThreadView steer now', () => {
  test('mid-turn with a draft, Steer now sends the correction and clears the composer', () => {
    model = makeModel({ turnActive: true });
    render(<ThreadView info={makeInfo({ status: 'running' })} />);

    // Nothing typed: no steer affordance to mis-click, only Stop.
    expect(screen.queryByTestId('agent-thread-steer')).toBeNull();

    const composer = screen.getByTestId('agent-thread-composer') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: '  actually, do this instead  ' } });

    // Both outcomes are offered side by side: wait your turn, or interrupt.
    expect(screen.getByTestId('agent-thread-send').getAttribute('aria-label')).toBe(
      'Queue message',
    );
    const steerButton = screen.getByTestId('agent-thread-steer');
    expect(steerButton.getAttribute('aria-label')).toBe('Steer now');

    fireEvent.click(steerButton);
    expect(steer).toHaveBeenCalledWith('thread-1', 'actually, do this instead', undefined);
    expect(prompt).not.toHaveBeenCalled();
    expect(composer.value).toBe('');
  });

  test('Enter still queues — steering is only ever an explicit click', () => {
    model = makeModel({ turnActive: true });
    render(<ThreadView info={makeInfo({ status: 'running' })} />);

    const composer = screen.getByTestId('agent-thread-composer');
    fireEvent.change(composer, { target: { value: 'queue me' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(prompt).toHaveBeenCalledWith('thread-1', 'queue me', undefined);
    expect(steer).not.toHaveBeenCalled();
  });

  test('outside a turn there is nothing to steer away from', () => {
    model = makeModel({ turnActive: false });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);

    fireEvent.change(screen.getByTestId('agent-thread-composer'), {
      target: { value: 'plain send' },
    });
    expect(screen.queryByTestId('agent-thread-steer')).toBeNull();
  });

  test('a parked steer shows the waiting strip with the correction previewed', () => {
    model = makeModel({ turnActive: true });
    render(
      <ThreadView
        info={makeInfo({ status: 'running', steer: { content: 'use the other API', ts: 1 } })}
      />,
    );

    const strip = screen.getByTestId('agent-thread-steer-pending');
    expect(strip.textContent).toContain('waiting for the current run to stop');
    expect(strip.textContent).toContain('use the other API');
  });

  test('Stop rescues the parked steer ahead of the queue', () => {
    model = makeModel({ turnActive: true });
    render(
      <ThreadView
        info={makeInfo({
          status: 'running',
          steer: { content: 'the correction', ts: 3 },
          queue: [{ id: 'q1', content: 'queued after', ts: 4 }],
        })}
      />,
    );

    fireEvent.click(screen.getByTestId('agent-thread-cancel'));

    expect(cancel).toHaveBeenCalledWith('thread-1');
    // Server-side both are dropped, so the composer is the only place the
    // words survive — steer first, because that is the order it would have run.
    const composer = screen.getByTestId('agent-thread-composer') as HTMLTextAreaElement;
    expect(composer.value).toBe('the correction\n\nqueued after');
  });
});

describe('ThreadView queued-message holds', () => {
  const oneQueued = (content = 'original text', held?: boolean) =>
    makeInfo({
      status: 'running',
      queue: [{ id: 'q1', content, ts: 1, ...(held === undefined ? {} : { held }) }],
    });

  test('opening the editor holds the row so the drain cannot take it', () => {
    model = makeModel({ turnActive: true });
    render(<ThreadView info={oneQueued()} />);

    fireEvent.click(screen.getByTestId('agent-thread-queued-edit'));
    expect(holdQueued).toHaveBeenCalledWith('thread-1', 'q1', true);
  });

  test('cancelling the edit releases the hold', () => {
    model = makeModel({ turnActive: true });
    render(<ThreadView info={oneQueued()} />);

    fireEvent.click(screen.getByTestId('agent-thread-queued-edit'));
    fireEvent.click(screen.getByTestId('agent-thread-queued-cancel-edit'));

    expect(holdQueued).toHaveBeenLastCalledWith('thread-1', 'q1', false);
    expect(editQueued).not.toHaveBeenCalled();
  });

  test('Escape releases the hold as well', () => {
    model = makeModel({ turnActive: true });
    render(<ThreadView info={oneQueued()} />);

    fireEvent.click(screen.getByTestId('agent-thread-queued-edit'));
    fireEvent.keyDown(screen.getByTestId('agent-thread-queued-input'), { key: 'Escape' });

    expect(holdQueued).toHaveBeenLastCalledWith('thread-1', 'q1', false);
  });

  test('saving changed text resubmits through the edit; the server clears the hold', () => {
    model = makeModel({ turnActive: true });
    render(<ThreadView info={oneQueued()} />);

    fireEvent.click(screen.getByTestId('agent-thread-queued-edit'));
    fireEvent.change(screen.getByTestId('agent-thread-queued-input'), {
      target: { value: 'sharper text' },
    });
    fireEvent.keyDown(screen.getByTestId('agent-thread-queued-input'), { key: 'Enter' });

    expect(editQueued).toHaveBeenCalledWith('thread-1', 'q1', 'sharper text');
    // A second release frame would race the edit's own clear.
    expect(holdQueued).toHaveBeenCalledTimes(1);
    expect(holdQueued).toHaveBeenCalledWith('thread-1', 'q1', true);
  });

  test('saving unchanged text just releases the hold — nothing to edit', () => {
    model = makeModel({ turnActive: true });
    render(<ThreadView info={oneQueued()} />);

    fireEvent.click(screen.getByTestId('agent-thread-queued-edit'));
    fireEvent.keyDown(screen.getByTestId('agent-thread-queued-input'), { key: 'Enter' });

    expect(editQueued).not.toHaveBeenCalled();
    expect(holdQueued).toHaveBeenLastCalledWith('thread-1', 'q1', false);
  });

  test('a held row is marked as held and offers to send it', () => {
    model = makeModel({ turnActive: true });
    render(<ThreadView info={oneQueued('parked text', true)} />);

    const row = screen.getByTestId('agent-thread-queued');
    expect(row.textContent).toContain('Held');
    expect(row.getAttribute('data-held')).toBe('true');

    fireEvent.click(within(row).getByTestId('agent-thread-queued-release'));
    expect(holdQueued).toHaveBeenCalledWith('thread-1', 'q1', false);
  });

  test('an ordinary queued row carries no held marking', () => {
    model = makeModel({ turnActive: true });
    render(<ThreadView info={oneQueued()} />);

    const row = screen.getByTestId('agent-thread-queued');
    expect(row.getAttribute('data-held')).toBeNull();
    expect(screen.queryByTestId('agent-thread-queued-release')).toBeNull();
  });

  test('an edit that lost its race says so instead of vanishing', async () => {
    editQueuedResult = Promise.reject(new Error('queued message already dispatched'));
    model = makeModel({ turnActive: true });
    render(<ThreadView info={oneQueued()} />);

    fireEvent.click(screen.getByTestId('agent-thread-queued-edit'));
    fireEvent.change(screen.getByTestId('agent-thread-queued-input'), {
      target: { value: 'too late' },
    });
    fireEvent.keyDown(screen.getByTestId('agent-thread-queued-input'), { key: 'Enter' });

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(String(toastError.mock.calls[0]?.[0])).toContain("wasn't applied");
  });
});

describe('ThreadView send-vs-queue labelling', () => {
  test('the queue header says when the messages actually go out', () => {
    model = makeModel({ turnActive: true });
    render(
      <ThreadView
        info={makeInfo({
          status: 'running',
          queue: [{ id: 'q1', content: 'waiting', ts: 1 }],
        })}
      />,
    );

    expect(screen.getByTestId('agent-thread-queue').textContent).toContain(
      'sends when this run finishes',
    );
  });

  test('mid-turn the action button wears the queue icon and explains itself', async () => {
    const user = userEvent.setup();
    model = makeModel({ turnActive: true });
    render(<ThreadView info={makeInfo({ status: 'running' })} />);

    fireEvent.change(screen.getByTestId('agent-thread-composer'), {
      target: { value: 'queued while running' },
    });

    const send = screen.getByTestId('agent-thread-send');
    // The aria-label alone was the only send-vs-queue tell; sighted users read
    // the glyph.
    expect(send.querySelector('svg')?.getAttribute('class')).toContain('list-plus');

    await user.hover(send);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('Queues behind the running turn');
  });

  test('outside a turn it is a plain send arrow with no queue tooltip', async () => {
    const user = userEvent.setup();
    model = makeModel({ turnActive: false });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);

    fireEvent.change(screen.getByTestId('agent-thread-composer'), {
      target: { value: 'idle send' },
    });

    const send = screen.getByTestId('agent-thread-send');
    expect(send.querySelector('svg')?.getAttribute('class')).toContain('arrow-up');

    await user.hover(send);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('ThreadView attachment disclosure', () => {
  test('a references-only agent explains that behavior on the attachment affordance', async () => {
    const user = userEvent.setup();
    model = makeModel({ turnActive: false });
    render(
      <ThreadView
        info={makeInfo({
          status: 'ready',
          promptCapabilities: { embeddedContext: false },
        })}
      />,
    );

    await user.hover(screen.getByTestId('agent-thread-attach-files'));

    expect((await screen.findByRole('tooltip')).textContent).toBe(
      'Attach a file · references only (no embedded contents)',
    );
  });

  test('an embedding-capable agent keeps the attachment tooltip concise', async () => {
    const user = userEvent.setup();
    model = makeModel({ turnActive: false });
    render(
      <ThreadView
        info={makeInfo({
          status: 'ready',
          promptCapabilities: { embeddedContext: true },
        })}
      />,
    );

    await user.hover(screen.getByTestId('agent-thread-attach-files'));

    expect((await screen.findByRole('tooltip')).textContent).toBe('Attach a file');
  });

  test('unknown capabilities do not flash a references-only claim during handshake', async () => {
    const user = userEvent.setup();
    model = makeModel({ turnActive: false });
    render(<ThreadView info={makeInfo({ status: 'ready', promptCapabilities: null })} />);

    await user.hover(screen.getByTestId('agent-thread-attach-files'));

    expect((await screen.findByRole('tooltip')).textContent).toBe('Attach a file');
  });
});

describe('ThreadView retry', () => {
  function failureNotice(
    reason: 'auth-required' | 'connect' | 'session-setup' | 'prompt',
  ): Extract<RenderedItem, { kind: 'notice' }> {
    return {
      kind: 'notice',
      text: '',
      tone: 'error',
      failure: { reason, agentMessage: 'harness not installed' },
      attempts: 1,
    };
  }

  test('a startup failure offers Retry and re-runs the launch', async () => {
    model = makeModel({ turnActive: false, items: [failureNotice('session-setup')] });
    render(<ThreadView info={makeInfo({ status: 'error' })} />);

    await userEvent.click(screen.getByTestId('agent-thread-retry'));
    expect(retryThread).toHaveBeenCalledWith('thread-1');
  });

  // Restore-to-composer is the prompt-failure counterpart to Retry: the session
  // is live so a launch respawn is wrong, but the failed text isn't retrievable
  // from the composer either (only from the transcript row above the notice).
  // The button seeds the composer from the nearest preceding user_message.
  test('a prompt failure offers Edit and resend instead of Retry, seeds the composer, and hides the failed pair', async () => {
    model = makeModel({
      turnActive: false,
      items: [
        {
          kind: 'message',
          role: 'user',
          text: 'give me a haiku about tokens',
          messageId: 'u1',
        },
        failureNotice('prompt'),
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'error' })} />);

    expect(screen.queryByTestId('agent-thread-retry')).toBeNull();
    const composer = screen.getByTestId('agent-thread-composer') as HTMLTextAreaElement;
    expect(composer.value).toBe('');
    expect(screen.getByTestId('agent-thread-user-message')).toBeDefined();
    expect(screen.getByTestId('agent-thread-notice')).toBeDefined();

    await userEvent.click(screen.getByTestId('agent-thread-restore'));

    // Edit-and-resend is a revert, not an append: the failed message + its
    // notice leave the transcript and the composer takes the text so the
    // user can edit and send anew. The transcript keeps other turns intact.
    expect(composer.value).toBe('give me a haiku about tokens');
    expect(screen.queryByTestId('agent-thread-user-message')).toBeNull();
    expect(screen.queryByTestId('agent-thread-notice')).toBeNull();
  });

  // Only the most-recent prompt failure carries the button, mirroring Retry's
  // one-card discipline. Older failures stay in the log as history — and the
  // restore reverse-scans from the notice for the NEAREST user message, not
  // the earliest, so the last failure resurfaces the last prompt (not the
  // first). A forward-scan regression would still leave the button count at
  // one but seed the wrong text; the click assertion is what guards that.
  test('only the last prompt failure carries the button, seeds from nearest, and hides only the reverted pair', async () => {
    model = makeModel({
      turnActive: false,
      items: [
        { kind: 'message', role: 'user', text: 'first try', messageId: 'u1' },
        failureNotice('prompt'),
        { kind: 'message', role: 'user', text: 'second try', messageId: 'u2' },
        failureNotice('prompt'),
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'error' })} />);

    const buttons = screen.getAllByTestId('agent-thread-restore');
    expect(buttons).toHaveLength(1);
    expect(screen.getAllByTestId('agent-thread-user-message')).toHaveLength(2);
    expect(screen.getAllByTestId('agent-thread-notice')).toHaveLength(2);

    const composer = screen.getByTestId('agent-thread-composer') as HTMLTextAreaElement;
    const button = buttons[0];
    if (!button) throw new Error('restore button missing');
    await userEvent.click(button);

    expect(composer.value).toBe('second try');
    // Only the reverted pair hides. The earlier failed turn stays as history.
    const users = screen.getAllByTestId('agent-thread-user-message');
    expect(users).toHaveLength(1);
    expect(users[0]?.textContent).toContain('first try');
    expect(screen.getAllByTestId('agent-thread-notice')).toHaveLength(1);
  });

  // Restore-to-composer is inert unless the composer is actually usable after
  // it. A prompt failure leaves `status: 'error'` (the session is alive, but
  // the top-level status still records the failed turn), and the composer's
  // Send is normally gated by `status === 'ready'`. The guard has to admit
  // this mid-session recoverable case or the button seeds text into a dead
  // composer.
  test('after Edit-and-resend the composer is usable — Send button becomes enabled and can send', async () => {
    const promptFn = prompt as ReturnType<typeof vi.fn>;
    promptFn.mockClear();
    model = makeModel({
      turnActive: false,
      items: [
        { kind: 'message', role: 'user', text: 'give me a haiku', messageId: 'u1' },
        failureNotice('prompt'),
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'error' })} />);

    // Before the restore the composer is empty and Send is disabled.
    const send = screen.getByTestId('agent-thread-send');
    expect(send.hasAttribute('disabled')).toBe(true);

    await userEvent.click(screen.getByTestId('agent-thread-restore'));

    // The seed lands, and the Send button lights up because the mid-session
    // failure guard now admits `status === 'error'` with a prompt reason.
    const composer = screen.getByTestId('agent-thread-composer') as HTMLTextAreaElement;
    expect(composer.value).toBe('give me a haiku');
    expect(send.hasAttribute('disabled')).toBe(false);

    // A real click flows through the send path — the wire call fires, so the
    // user can actually retry the prompt they just edited.
    await userEvent.click(send);
    expect(promptFn).toHaveBeenCalledWith('thread-1', 'give me a haiku', undefined);
  });

  // The `restoreNoticeIndex` guard tests both `!archived` and `status !==
  // 'exited'`. An exited thread has no live agent, so restore has no
  // destination; the sibling test to `archived thread offers no
  // Edit-and-resend` closes the other branch of the same guard.
  test('an exited thread offers no Edit-and-resend', () => {
    model = makeModel({
      turnActive: false,
      items: [
        { kind: 'message', role: 'user', text: 'give me a haiku', messageId: 'u1' },
        failureNotice('prompt'),
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'exited', archived: false })} />);

    expect(screen.queryByTestId('agent-thread-restore')).toBeNull();
  });

  // An attachment-only prompt lands as a real user item with `text: ''` in
  // the fold. The scan stops at the first `role === 'user'` regardless of
  // text so it can't step past this row into an earlier turn.
  test('Edit-and-resend is a no-op when the failed prompt has no text', async () => {
    model = makeModel({
      turnActive: false,
      items: [
        { kind: 'message', role: 'user', text: '', messageId: 'u1' },
        failureNotice('prompt'),
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'error' })} />);

    const composer = screen.getByTestId('agent-thread-composer') as HTMLTextAreaElement;
    await userEvent.click(screen.getByTestId('agent-thread-restore'));
    expect(composer.value).toBe('');
  });

  // The wrong-turn hazard: the scan must stop at the failed prompt's OWN user
  // row even when that row has no text — otherwise an attachment-only prompt
  // that failed pulls text from an earlier, unrelated turn's user message.
  test('an attachment-only failed prompt does not restore text from an earlier turn', async () => {
    model = makeModel({
      turnActive: false,
      items: [
        { kind: 'message', role: 'user', text: 'earlier unrelated turn', messageId: 'u1' },
        { kind: 'message', role: 'agent', text: 'ok', messageId: 'a1' },
        { kind: 'message', role: 'user', text: '', messageId: 'u2' },
        failureNotice('prompt'),
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'error' })} />);

    const composer = screen.getByTestId('agent-thread-composer') as HTMLTextAreaElement;
    await userEvent.click(screen.getByTestId('agent-thread-restore'));
    expect(composer.value).toBe('');
  });

  // Archived threads are read-only — the composer is disabled — so the
  // restore action has no destination.
  test('an archived thread offers no Edit-and-resend', () => {
    model = makeModel({
      turnActive: false,
      items: [
        { kind: 'message', role: 'user', text: 'give me a haiku', messageId: 'u1' },
        failureNotice('prompt'),
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'error', archived: true })} />);

    expect(screen.queryByTestId('agent-thread-restore')).toBeNull();
  });

  // A transcript accumulates a notice per failed attempt; Retry belongs to the
  // one the user is looking at, not to every one they have ever seen.
  test('only the last startup failure carries the button', () => {
    model = makeModel({
      turnActive: false,
      items: [failureNotice('connect'), failureNotice('session-setup')],
    });
    render(<ThreadView info={makeInfo({ status: 'auth_required' })} />);

    expect(screen.getAllByTestId('agent-thread-notice')).toHaveLength(2);
    const buttons = screen.getAllByTestId('agent-thread-retry');
    expect(buttons).toHaveLength(1);
    const notices = screen.getAllByTestId('agent-thread-notice');
    expect(notices[1]?.contains(buttons[0] ?? null)).toBe(true);
  });

  test('an archived thread offers no Retry — that one resumes', () => {
    model = makeModel({ turnActive: false, items: [failureNotice('session-setup')] });
    render(<ThreadView info={makeInfo({ status: 'error', archived: true })} />);

    expect(screen.queryByTestId('agent-thread-retry')).toBeNull();
  });

  test('an auth failure offers a sign-in button that authenticates in place', async () => {
    model = makeModel({
      turnActive: false,
      items: [
        {
          kind: 'notice',
          text: '',
          tone: 'info',
          failure: {
            reason: 'auth-required',
            authMethods: [{ id: 'test_login', name: 'Test Login' }],
          },
          attempts: 1,
        },
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'auth_required' })} />);

    const button = screen.getByTestId('agent-thread-auth-method');
    expect(button.getAttribute('data-auth-method-id')).toBe('test_login');
    expect(button.textContent).toContain('Sign in with Test Login');
    await userEvent.click(button);
    expect(authenticateThread).toHaveBeenCalledWith('thread-1', 'test_login');
    // Retry stays: "I signed in elsewhere, try again" is still a valid answer.
    expect(screen.getByTestId('agent-thread-retry')).toBeDefined();
  });

  // Several ways in are still one decision: the agent's first method leads and
  // the alternatives stay quiet, so the pane never reads as competing demands.
  test('only the first sign-in method carries the primary weight', () => {
    model = makeModel({
      turnActive: false,
      items: [
        {
          kind: 'notice',
          text: '',
          tone: 'info',
          failure: {
            reason: 'auth-required',
            authMethods: [
              { id: 'ioa', name: 'IoA' },
              { id: 'google', name: 'Google' },
              { id: 'sso', name: 'Enterprise domain' },
            ],
          },
        },
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'auth_required' })} />);

    // The rule is "exactly one primary, and it's the first" — which quiet
    // variant the alternatives wear is a styling call, free to be retuned.
    const variants = screen
      .getAllByTestId('agent-thread-auth-method')
      .map((b) => b.getAttribute('data-variant'));
    expect(variants).toHaveLength(3);
    expect(variants[0]).toBe('default');
    expect(variants.slice(1).every((v) => v !== 'default')).toBe(true);
  });

  // Alone under the stack, Retry is a lone muted word with nothing to explain
  // it; beside a details toggle it has company, and the framing would only make
  // the pair wordy.
  test('Retry is framed as a question only when it stands alone', () => {
    const authFailure = (machineDetail?: string): Extract<RenderedItem, { kind: 'notice' }> => ({
      kind: 'notice',
      text: '',
      tone: 'info',
      failure: {
        reason: 'auth-required',
        authMethods: [{ id: 'test_login', name: 'Test Login' }],
        ...(machineDetail === undefined ? {} : { machineDetail }),
      },
    });

    model = makeModel({ turnActive: false, items: [authFailure()] });
    const alone = render(<ThreadView info={makeInfo({ status: 'auth_required' })} />);
    expect(screen.getByTestId('agent-thread-notice').textContent).toContain('Already signed in?');
    alone.unmount();

    model = makeModel({ turnActive: false, items: [authFailure('{"detail":"x"}')] });
    render(<ThreadView info={makeInfo({ status: 'auth_required' })} />);
    expect(screen.getByTestId('agent-thread-notice-details-toggle')).toBeDefined();
    expect(screen.getByTestId('agent-thread-notice').textContent).not.toContain(
      'Already signed in?',
    );
  });

  // Clicking a method used to drop the prompt and say "Starting the agent…" —
  // a claim the user could see was false, since they had not signed in yet.
  test('a sign-in in flight reads as a wait, not as the agent starting', () => {
    model = makeModel({
      turnActive: false,
      items: [
        {
          kind: 'notice',
          text: '',
          tone: 'info',
          failure: {
            reason: 'auth-required',
            authMethods: [{ id: 'test_login', name: 'Test Login' }],
          },
        },
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'authenticating' })} />);

    const card = screen.getByTestId('agent-thread-notice');
    expect(card.textContent).toContain('Signing in to Claude');
    // The offer is over: the methods stop inviting a second click, and nothing
    // claims the agent is on its way.
    expect(screen.queryByTestId('agent-thread-auth-method')).toBeNull();
    expect(screen.queryByTestId('agent-thread-starting')).toBeNull();
    expect(card.textContent).not.toContain('Already signed in?');
    // Abandoning the sign-in in a browser tab parks the thread until it times
    // out, so the way back stays on screen throughout.
    expect(screen.getByTestId('agent-thread-retry')).toBeDefined();
  });

  // The browser asks the user to confirm a device code against what their
  // device shows. If OK shows nothing, they confirm blind and the check is
  // theatre — so the agent's own words go on screen while the wait is live.
  test('a sign-in in flight shows what the agent printed', () => {
    model = makeModel({
      turnActive: false,
      items: [
        {
          kind: 'notice',
          text: '',
          tone: 'info',
          failure: {
            reason: 'auth-required',
            authMethods: [{ id: 'test_login', name: 'Test Login' }],
          },
        },
      ],
    });
    render(
      <ThreadView
        info={makeInfo({
          status: 'authenticating',
          signInOutput: [
            '[acp/auth] Starting OAuth login for cline…',
            '[acp/auth] Enter this code in your browser: CRQT-NXNT',
            '[acp/auth] https://authkit.cline.bot/device?user_code=CRQT-NXNT',
          ],
        })}
      />,
    );

    // The code is the focus, one tap to copy, with the page to confirm it at
    // underneath — not a wall of log lines to squint through.
    expect(screen.getByTestId('agent-thread-sign-in-code').textContent).toContain('CRQT-NXNT');
    expect(screen.getByTestId('agent-thread-sign-in-url').textContent).toBe(
      'authkit.cline.bot/device',
    );
  });

  // The headline swap is silent to anyone not looking at it: the shimmer reads
  // as progress visually and as nothing to a screen reader.
  test('the sign-in transition is announced to assistive tech', () => {
    const authNotice: Extract<RenderedItem, { kind: 'notice' }> = {
      kind: 'notice',
      text: '',
      tone: 'info',
      failure: { reason: 'auth-required', authMethods: [{ id: 'test_login', name: 'Test Login' }] },
    };

    model = makeModel({ turnActive: false, items: [authNotice] });
    const parked = render(<ThreadView info={makeInfo({ status: 'auth_required' })} />);
    const regions = () => screen.getAllByRole('status').map((n) => n.textContent);
    // Mounted before the transition, and empty — a region that appears and
    // fills in one cycle is missed on VoiceOver.
    expect(regions()).toContain('');
    parked.unmount();

    model = makeModel({ turnActive: false, items: [authNotice] });
    render(<ThreadView info={makeInfo({ status: 'authenticating' })} />);
    expect(regions().join(' ')).toContain('Signing in to Claude');
  });

  // Copy feedback is an icon swap, which is no feedback at all without this.
  test('copying the code is announced to assistive tech', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    model = makeModel({
      turnActive: false,
      items: [
        {
          kind: 'notice',
          text: '',
          tone: 'info',
          failure: {
            reason: 'auth-required',
            authMethods: [{ id: 'test_login', name: 'Test Login' }],
          },
        },
      ],
    });
    render(
      <ThreadView
        info={makeInfo({
          status: 'authenticating',
          signInOutput: ['[acp/auth] Enter this code in your browser: CRQT-NXNT'],
        })}
      />,
    );

    await userEvent.click(screen.getByTestId('agent-thread-sign-in-code'));

    expect(writeText).toHaveBeenCalledWith('CRQT-NXNT');
    await vi.waitFor(() =>
      expect(screen.getAllByRole('status').map((n) => n.textContent)).toContain('Code copied'),
    );
    vi.unstubAllGlobals();
  });

  // A flow shaped differently must still reach the user: this stderr is the
  // only channel a sign-in has before a session exists.
  test('a sign-in that prints something unrecognized shows it verbatim', () => {
    model = makeModel({
      turnActive: false,
      items: [
        {
          kind: 'notice',
          text: '',
          tone: 'info',
          failure: {
            reason: 'auth-required',
            authMethods: [{ id: 'test_login', name: 'Test Login' }],
          },
        },
      ],
    });
    render(
      <ThreadView
        info={makeInfo({ status: 'authenticating', signInOutput: ['[auth] check your email'] })}
      />,
    );

    expect(screen.queryByTestId('agent-thread-sign-in-code')).toBeNull();
    expect(screen.getByTestId('agent-thread-sign-in-output').textContent).toContain(
      'check your email',
    );
  });

  // Nothing to say yet: an empty channel must not leave an empty box behind.
  test('a sign-in with nothing printed shows no output block', () => {
    model = makeModel({
      turnActive: false,
      items: [
        {
          kind: 'notice',
          text: '',
          tone: 'info',
          failure: {
            reason: 'auth-required',
            authMethods: [{ id: 'test_login', name: 'Test Login' }],
          },
        },
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'authenticating' })} />);

    expect(screen.queryByTestId('agent-thread-sign-in-output')).toBeNull();
  });

  // Nothing has been said in this thread yet, so the sign-in is the whole
  // screen — not an alert stacked on top of the startup failures it replaces.
  test('a sign-in on an unstarted thread replaces the startup notices', () => {
    model = makeModel({
      turnActive: false,
      items: [
        failureNotice('connect'),
        {
          kind: 'notice',
          text: '',
          tone: 'info',
          failure: {
            reason: 'auth-required',
            authMethods: [{ id: 'test_login', name: 'Test Login' }],
          },
        },
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'auth_required' })} />);

    const notices = screen.getAllByTestId('agent-thread-notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.contains(screen.getByTestId('agent-thread-auth-method'))).toBe(true);
    expect(notices[0]?.textContent).not.toContain("couldn't start");
  });

  test('a refused sign-in surfaces the reason and leaves the button usable', async () => {
    authenticateResult = Promise.reject(new Error('wrong account'));
    model = makeModel({
      turnActive: false,
      items: [
        {
          kind: 'notice',
          text: '',
          tone: 'info',
          failure: {
            reason: 'auth-required',
            authMethods: [{ id: 'test_login', name: 'Test Login' }],
          },
          attempts: 1,
        },
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'auth_required' })} />);

    // Synchronous click: the pre-armed rejection has to meet its handler in
    // this same tick, or Node reports it as unhandled before the click lands.
    fireEvent.click(screen.getByTestId('agent-thread-auth-method'));

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(String(toastError.mock.calls[0]?.[0])).toContain('wrong account');
    expect(screen.getByTestId('agent-thread-auth-method').hasAttribute('disabled')).toBe(false);
  });

  // A terminal/env_var sign-in happens in the user's own shell — a button OK
  // can't complete would be a promise it has no way to keep.
  test('a terminal-kind method is named, not offered as a button', () => {
    model = makeModel({
      turnActive: false,
      items: [
        {
          kind: 'notice',
          text: '',
          tone: 'info',
          failure: {
            reason: 'auth-required',
            authMethods: [
              {
                id: 'cli_login',
                name: 'CLI Login',
                description: 'Run `agent login`',
                kind: 'terminal',
              },
            ],
          },
          attempts: 1,
        },
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'auth_required' })} />);

    expect(screen.queryByTestId('agent-thread-auth-method')).toBeNull();
    expect(screen.getByTestId('agent-thread-auth-manual').textContent).toContain('CLI Login');
    expect(screen.getByTestId('agent-thread-auth-manual').textContent).toContain('agent login');
    expect(screen.getByTestId('agent-thread-retry')).toBeDefined();
  });

  // Signing in takes a detour through a browser; a draft written before it has
  // to survive, so the field stays typable even though sending is still gated.
  test('the composer stays typable while the thread waits on sign-in', () => {
    model = makeModel({ turnActive: false, items: [] });
    render(<ThreadView info={makeInfo({ status: 'auth_required' })} />);

    const composer = screen.getByTestId('agent-thread-composer');
    expect(composer.hasAttribute('disabled')).toBe(false);
    fireEvent.change(composer, { target: { value: 'draft while signing in' } });
    expect((composer as HTMLTextAreaElement).value).toBe('draft while signing in');
    expect(screen.getByTestId('agent-thread-send').hasAttribute('disabled')).toBe(true);
  });

  // Clicking Sign in flips the status to `installing` — the same field the
  // draft was written in must not go read-only underneath it.
  test('the composer stays typable once the sign-in is under way', () => {
    model = makeModel({ turnActive: false, items: [] });
    render(<ThreadView info={makeInfo({ status: 'authenticating' })} />);

    const composer = screen.getByTestId('agent-thread-composer');
    expect(composer.hasAttribute('disabled')).toBe(false);
    fireEvent.change(composer, { target: { value: 'kept across the sign-in' } });
    expect((composer as HTMLTextAreaElement).value).toBe('kept across the sign-in');
    expect(screen.getByTestId('agent-thread-send').hasAttribute('disabled')).toBe(true);
  });

  test('a thread whose agent is gone for good has nothing left to type into', () => {
    model = makeModel({ turnActive: false, items: [] });
    render(<ThreadView info={makeInfo({ status: 'exited' })} />);

    expect(screen.getByTestId('agent-thread-composer').hasAttribute('disabled')).toBe(true);
  });

  test('the header names the build OK launched', () => {
    model = makeModel({ turnActive: false, items: [] });
    render(
      <ThreadView
        info={makeInfo({
          status: 'ready',
          agent: { id: 'claude', name: 'Claude Agent', source: 'registry', version: '0.53.0' },
        })}
      />,
    );

    expect(screen.getByTestId('agent-thread-agent-version').textContent).toBe('0.53.0');
  });
});
describe('ThreadView failure notices', () => {
  function notice(
    overrides?: Partial<Extract<RenderedItem, { kind: 'notice' }>>,
  ): Extract<RenderedItem, { kind: 'notice' }> {
    return {
      kind: 'notice',
      text: '',
      tone: 'error',
      failure: null,
      attempts: 1,
      ...overrides,
    };
  }

  test('an auth failure reads as sign-in copy, quotes the agent, and hides the wire payload', async () => {
    model = makeModel({
      turnActive: false,
      items: [
        notice({
          tone: 'info',
          failure: {
            reason: 'auth-required',
            agentMessage: 'Authentication required',
            machineDetail: '{"detail":"run /login first"}',
            authMethods: [{ id: 'test_login', name: 'Test Login' }],
          },
        }),
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'auth_required' })} />);

    const card = screen.getByTestId('agent-thread-notice');
    // "Claude Agent" reads as the brand in copy — the display name drops the suffix.
    expect(card.textContent).toContain('Sign in to Claude to continue');
    expect(card.textContent).toContain('Authentication required');
    // The JSON payload is diagnostic, not headline copy: it stays behind the
    // disclosure until the user asks for it.
    expect(card.textContent).not.toContain('run /login first');
    expect(screen.queryByTestId('agent-thread-notice-details')).toBeNull();

    const toggle = screen.getByTestId('agent-thread-notice-details-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(toggle);

    expect(screen.getByTestId('agent-thread-notice-details').textContent).toContain(
      'run /login first',
    );
    expect(
      screen.getByTestId('agent-thread-notice-details-toggle').getAttribute('aria-expanded'),
    ).toBe('true');
  });

  test('a session-setup failure names the step that broke', () => {
    model = makeModel({
      turnActive: false,
      items: [
        notice({
          failure: {
            reason: 'session-setup',
            agentMessage: 'Failed to initialize session services',
          },
        }),
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'error' })} />);

    const card = screen.getByTestId('agent-thread-notice');
    expect(card.textContent).toContain("Claude couldn't start a conversation");
    expect(card.textContent).toContain('Failed to initialize session services');
    // Nothing machine-readable was attached, so no disclosure is offered.
    expect(screen.queryByTestId('agent-thread-notice-details-toggle')).toBeNull();
  });

  test('a legacy detail-only error still renders its raw text', () => {
    model = makeModel({
      turnActive: false,
      items: [notice({ text: 'session setup failed: boom' })],
    });
    render(<ThreadView info={makeInfo({ status: 'error' })} />);

    const card = screen.getByTestId('agent-thread-notice');
    expect(card.textContent).toBe('session setup failed: boom');
    expect(screen.queryByTestId('agent-thread-notice-details-toggle')).toBeNull();
  });

  // Regression guard for extractRootCauseLine: npm prints the cause up-front
  // and follows it with an "A complete log of this run can be found in: …"
  // epilogue. A last-match heuristic picks the log-path — the single line
  // this feature exists to skip past.
  test('root-cause line picks the CAUSE, not the "complete log" epilogue', () => {
    const stderr = [
      'npm error code EUSAGE',
      'npm error',
      'npm error usage: npm ci',
      'npm error',
      'npm error Run npm help ci for more info',
      'npm error',
      'npm error A complete log of this run can be found in: /tmp/log.txt',
    ].join('\n');
    model = makeModel({
      turnActive: false,
      items: [
        notice({
          failure: {
            reason: 'connect',
            agentMessage: 'initialize failed',
            machineDetail: stderr,
          },
        }),
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'error' })} />);

    const rootCause = screen.getByTestId('agent-thread-notice-root-cause');
    expect(rootCause.textContent).toContain('code EUSAGE');
    expect(rootCause.textContent).not.toContain('complete log of this run');
  });
});

/**
 * Runtime status the agent reported, drawn as chrome rather than speech.
 *
 * The defect this row exists to fix is misattribution: an operational warning
 * that reads as the agent's answer gets acted on as if the agent had said it.
 * So the assertions here are about what separates the two — a label, a glyph,
 * a box — and about what the row must NOT offer, since passive guidance with a
 * Retry button invites an action that does nothing.
 */
describe('ThreadView agent notices', () => {
  const WARNING_TEXT = 'Warning: Skill "foo" was not loaded because its manifest is invalid.\n\n';

  function agentNotice(text = WARNING_TEXT): Extract<RenderedItem, { kind: 'agent_notice' }> {
    return { kind: 'agent_notice', source: 'codex_legacy', severity: 'warning', text, seq: 0 };
  }

  test('reads as a runtime warning, not as the agent speaking', () => {
    model = makeModel({ turnActive: false, items: [agentNotice()] });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);

    const card = screen.getByRole('note');
    expect(card).toBe(screen.getByTestId('agent-thread-agent-notice'));
    // Three cues, because any one of them can be unavailable: the label for a
    // reader who cannot see the box, the glyph for one skimming, and the
    // border for forced-colors mode, where the amber fill is discarded.
    expect(card.textContent).toContain('Warning');
    expect(card.className).toContain('border');
    expect(card.className).toContain('amber');
    const glyph = card.querySelector('svg');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    // Not an assistant bubble — that is the whole point of the row.
    expect(screen.queryByTestId('agent-thread-agent-message')).toBeNull();
  });

  test('shows the producer text verbatim through the same renderer as a reply', () => {
    model = makeModel({ turnActive: false, items: [agentNotice()] });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);

    const rendered = within(screen.getByTestId('agent-thread-agent-notice')).getByTestId(
      'rendered-markdown',
    );
    expect(rendered.textContent).toBe(WARNING_TEXT);
  });

  test('offers nothing to act on and opens no toast', () => {
    model = makeModel({ turnActive: false, items: [agentNotice()] });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);

    const card = screen.getByTestId('agent-thread-agent-notice');
    expect(within(card).queryAllByRole('button')).toHaveLength(0);
    expect(within(card).queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryByTestId('agent-thread-retry')).toBeNull();
    expect(screen.queryByTestId('agent-thread-restore')).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
  });

  test('sits in source order between the turns it interrupted', () => {
    model = makeModel({
      turnActive: false,
      items: [
        { kind: 'message', role: 'user', text: 'ship it', messageId: 'u1' },
        agentNotice(),
        { kind: 'message', role: 'agent', text: 'Done.', messageId: 'a1' },
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);

    const card = screen.getByTestId('agent-thread-agent-notice');
    const answer = screen.getByTestId('agent-thread-agent-message');
    expect(screen.getByTestId('agent-thread-user-message').compareDocumentPosition(card)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(card.compareDocumentPosition(answer)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // The answer keeps its own bubble: warning chrome never absorbs it.
    expect(within(answer).getByTestId('rendered-markdown').textContent).toBe('Done.');
  });

  test('two warnings in one turn stay two rows', () => {
    model = makeModel({
      turnActive: false,
      items: [agentNotice('Warning: first\n\n'), agentNotice('Warning: second\n\n')],
    });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);

    const cards = screen.getAllByTestId('agent-thread-agent-notice');
    expect(cards.map((card) => within(card).getByTestId('rendered-markdown').textContent)).toEqual([
      'Warning: first\n\n',
      'Warning: second\n\n',
    ]);
  });

  test('leaves an adjacent failure notice its own actions', async () => {
    model = makeModel({
      turnActive: false,
      items: [
        agentNotice(),
        {
          kind: 'notice',
          text: '',
          tone: 'error',
          attempts: 1,
          failure: { reason: 'connect', agentMessage: 'initialize failed' },
        },
      ],
    });
    render(<ThreadView info={makeInfo({ status: 'error' })} />);

    const failure = screen.getByTestId('agent-thread-notice');
    expect(failure.textContent).toContain("Claude couldn't start");
    // Retry belongs to the failure card, and the warning card sits outside it.
    const retry = screen.getByTestId('agent-thread-retry');
    expect(failure.contains(retry)).toBe(true);
    expect(screen.getByTestId('agent-thread-agent-notice').contains(retry)).toBe(false);

    await userEvent.click(retry);
    expect(retryThread).toHaveBeenCalledWith('thread-1');
  });
});

/**
 * Arrival announcements for runtime warnings.
 *
 * A warning card is silent by construction — it draws itself and offers
 * nothing to act on — so a reader who cannot see the transcript gets no cue
 * that one appeared. The polite region is that cue. The two failure modes it
 * has to avoid are opposite: saying nothing when a warning lands mid-turn, and
 * reciting a month of history to anyone who reopens an old thread.
 */
describe('ThreadView warning announcements', () => {
  const CODEX = { id: 'codex-acp', name: 'Codex', source: 'registry' as const };
  const FIRST = 'Warning: skill "alpha" was skipped\n\nIts manifest is invalid.\n\n';
  const SECOND = 'Warning: skill "beta" was skipped\n\n';

  function notice(text: string, seq: number): Extract<RenderedItem, { kind: 'agent_notice' }> {
    return { kind: 'agent_notice', source: 'codex_legacy', severity: 'warning', text, seq };
  }

  function announcer(): HTMLElement {
    return screen.getByTestId('agent-thread-warning-announcer');
  }

  /** A thread whose retained log has been fully folded — nothing left to replay. */
  function settled(seq: number) {
    threadState = { info: undefined, events: [], lastSeq: seq, replayThroughSeq: seq };
    return makeInfo({ status: 'ready', agent: CODEX, lastSeq: seq });
  }

  test('mounts the region empty, before any warning exists', () => {
    model = makeModel({ turnActive: false, items: [] });
    render(<ThreadView info={settled(5)} />);

    const region = announcer();
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-atomic')).toBe('true');
    expect(region.className).toContain('sr-only');
    expect(region.textContent).toBe('');
  });

  test('announces a warning that arrives during the session', async () => {
    model = makeModel({ turnActive: true, items: [] });
    const { rerender } = render(<ThreadView info={settled(5)} />);

    threadState = { info: undefined, events: [], lastSeq: 6, replayThroughSeq: 5 };
    model = makeModel({ turnActive: true, items: [notice(FIRST, 6)] });
    rerender(<ThreadView info={settled(5)} />);

    // The agent's own opening line, framed by app copy that says who reported
    // it — the detail paragraph stays on the card rather than in the queue.
    await waitFor(() =>
      expect(announcer().textContent).toBe('Codex reported: Warning: skill "alpha" was skipped'),
    );
  });

  test('serializes two warnings from one turn in source order', async () => {
    model = makeModel({ turnActive: true, items: [] });
    const { rerender } = render(<ThreadView info={settled(5)} />);

    threadState = { info: undefined, events: [], lastSeq: 7, replayThroughSeq: 5 };
    model = makeModel({ turnActive: true, items: [notice(FIRST, 6), notice(SECOND, 7)] });
    rerender(<ThreadView info={settled(5)} />);

    await waitFor(() =>
      expect(announcer().textContent).toBe('Codex reported: Warning: skill "alpha" was skipped'),
    );
    // The second one waits its turn instead of replacing the first before it
    // has been read out.
    await waitFor(
      () =>
        expect(announcer().textContent).toBe('Codex reported: Warning: skill "beta" was skipped'),
      { timeout: 2000 },
    );
  });

  test('draws a replayed transcript without announcing any of it', () => {
    // Mounted before the retained log has been folded — what arrives next is
    // history, not news.
    threadState = { info: undefined, events: [], lastSeq: -1, replayThroughSeq: 4 };
    model = makeModel({ turnActive: false, items: [] });
    const info = makeInfo({ status: 'ready', agent: CODEX, lastSeq: 4 });
    const { rerender } = render(<ThreadView info={info} />);

    threadState = { info: undefined, events: [], lastSeq: 4, replayThroughSeq: 4 };
    model = makeModel({ turnActive: false, items: [notice(FIRST, 2), notice(SECOND, 4)] });
    rerender(<ThreadView info={info} />);

    expect(screen.getAllByTestId('agent-thread-agent-notice')).toHaveLength(2);
    expect(announcer().textContent).toBe('');
  });

  test('speaks the first warning that lands after a replayed transcript settles', async () => {
    threadState = { info: undefined, events: [], lastSeq: -1, replayThroughSeq: 4 };
    model = makeModel({ turnActive: false, items: [] });
    const info = makeInfo({ status: 'ready', agent: CODEX, lastSeq: 4 });
    const { rerender } = render(<ThreadView info={info} />);

    threadState = { info: undefined, events: [], lastSeq: 4, replayThroughSeq: 4 };
    model = makeModel({ turnActive: false, items: [notice(FIRST, 3)] });
    rerender(<ThreadView info={info} />);
    expect(announcer().textContent).toBe('');

    threadState = { info: undefined, events: [], lastSeq: 5, replayThroughSeq: 4 };
    model = makeModel({ turnActive: true, items: [notice(FIRST, 3), notice(SECOND, 5)] });
    rerender(<ThreadView info={info} />);

    await waitFor(() =>
      expect(announcer().textContent).toBe('Codex reported: Warning: skill "beta" was skipped'),
    );
  });

  test('speaks a warning that lands in the batch that closes the replay window', async () => {
    // The server advances `info.lastSeq` the moment it appends while event
    // batches coalesce on a timer, so delivery and that field cross back and
    // forth all session. The subscription's own bound is what separates
    // history from news, and the warning above it has to be spoken even when
    // the batch carrying it is also the one that catches delivery up.
    threadState = { info: undefined, events: [], lastSeq: -1, replayThroughSeq: 4 };
    model = makeModel({ turnActive: false, items: [] });
    const { rerender } = render(
      <ThreadView info={makeInfo({ status: 'ready', agent: CODEX, lastSeq: 4 })} />,
    );

    // The retained log lands, but an info snapshot has already raced past it.
    threadState = { info: undefined, events: [], lastSeq: 4, replayThroughSeq: 4 };
    model = makeModel({ turnActive: false, items: [notice(FIRST, 2)] });
    rerender(<ThreadView info={makeInfo({ status: 'ready', agent: CODEX, lastSeq: 8 })} />);
    expect(announcer().textContent).toBe('');

    // The live batch that catches delivery up carries the warning with it.
    threadState = { info: undefined, events: [], lastSeq: 8, replayThroughSeq: 4 };
    model = makeModel({ turnActive: true, items: [notice(FIRST, 2), notice(SECOND, 8)] });
    rerender(<ThreadView info={makeInfo({ status: 'ready', agent: CODEX, lastSeq: 8 })} />);

    await waitFor(() =>
      expect(announcer().textContent).toBe('Codex reported: Warning: skill "beta" was skipped'),
    );
  });

  test('stays silent when a reconnect replays a warning it already delivered', async () => {
    const info = makeInfo({ status: 'ready', agent: CODEX, lastSeq: 6 });
    threadState = { info: undefined, events: [], lastSeq: 6, replayThroughSeq: 5 };
    model = makeModel({ turnActive: true, items: [notice(FIRST, 6)] });
    const { rerender } = render(<ThreadView info={info} />);
    await waitFor(() =>
      expect(announcer().textContent).toBe('Codex reported: Warning: skill "alpha" was skipped'),
    );

    // Content alone cannot tell a second announcement from the first: they
    // are the same string. Count the writes instead.
    const spoken: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          const text = node.textContent ?? '';
          if (text !== '') spoken.push(text);
        }
      }
    });
    observer.observe(announcer(), { childList: true });

    // The socket drops and resubscribes. The server re-announces its retained
    // log, which now covers the warning already spoken — a bound that moves
    // with the log is what keeps the reader from hearing it a second time.
    threadState = { info: undefined, events: [], lastSeq: -1, replayThroughSeq: 6 };
    model = makeModel({ turnActive: false, items: [] });
    rerender(<ThreadView info={info} />);
    threadState = { info: undefined, events: [], lastSeq: 6, replayThroughSeq: 6 };
    model = makeModel({ turnActive: false, items: [notice(FIRST, 6)] });
    rerender(<ThreadView info={info} />);

    await new Promise((resolve) => setTimeout(resolve, 400));
    observer.disconnect();
    expect(spoken).toEqual([]);
  });

  test('leaves the active element alone when a warning arrives', async () => {
    model = makeModel({ turnActive: true, items: [] });
    const { rerender } = render(<ThreadView info={settled(5)} />);
    const composer = screen.getByTestId('agent-thread-composer');
    composer.focus();
    expect(document.activeElement).toBe(composer);

    threadState = { info: undefined, events: [], lastSeq: 6, replayThroughSeq: 5 };
    model = makeModel({ turnActive: true, items: [notice(FIRST, 6)] });
    rerender(<ThreadView info={settled(5)} />);

    await waitFor(() => expect(announcer().textContent).not.toBe(''));
    expect(document.activeElement).toBe(composer);
  });
});

/**
 * Sent messages render as markdown, like the agent's replies.
 *
 * They used to print verbatim. Fine for a typed sentence, wrong for a comment
 * batch: that prompt is composed markdown, so the reader saw the raw `>`
 * blockquotes and backticks the agent parses instead of the passages they mark.
 */
describe('the transcript renders both sides as markdown', () => {
  test('a sent message goes through the renderer', async () => {
    model = {
      items: [{ kind: 'message', role: 'user', text: '> quoted', messageId: 'u1' }],
      plan: [],
      turnActive: false,
      tokenUsage: null,
      terminals: {},
      permissionsByToolCall: {},
    };
    render(<ThreadView info={makeInfo()} />);
    const bubble = screen.getByTestId('agent-thread-user-message');
    expect(bubble.querySelector('[data-testid="rendered-markdown"]')).not.toBeNull();
  });

  test('the sent bubble does not also pre-wrap, which would fight the renderer', async () => {
    model = {
      items: [{ kind: 'message', role: 'user', text: 'hello', messageId: 'u1' }],
      plan: [],
      turnActive: false,
      tokenUsage: null,
      terminals: {},
      permissionsByToolCall: {},
    };
    render(<ThreadView info={makeInfo()} />);
    expect(screen.getByTestId('agent-thread-user-message').className).not.toContain(
      'whitespace-pre-wrap',
    );
  });
});

describe('ThreadView drop-notice for unattachable files', () => {
  const makeFile = (name: string, type: string) => new File(['content'], name, { type });

  const fireDrop = (files: readonly File[]) => {
    const dt = {
      types: ['Files'],
      files,
      items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
      dropEffect: 'copy',
    };
    const root = document.querySelector('[data-agent-thread-root]');
    if (root === null) throw new Error('agent-thread-root not mounted');
    act(() => {
      fireEvent.dragEnter(root, { dataTransfer: dt });
      fireEvent.dragOver(root, { dataTransfer: dt });
      fireEvent.drop(root, { dataTransfer: dt });
    });
  };

  test('a web-host drop of non-image files renders the unknown-path notice', async () => {
    model = makeModel({ items: [], turnActive: false });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    fireDrop([makeFile('foo.ts', 'text/typescript'), makeFile('bar.md', 'text/markdown')]);
    const notice = await screen.findByTestId('agent-thread-drop-notice');
    expect(notice.textContent).toContain("this browser can't attach files by path");
    expect(notice.textContent).toContain('2 files');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.getAttribute('aria-live')).toBe('polite');
  });

  test('the notice clears after the auto-dismiss window', async () => {
    vi.useFakeTimers();
    model = makeModel({ items: [], turnActive: false });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    fireDrop([makeFile('foo.ts', 'text/typescript')]);
    await vi.waitFor(() =>
      expect(screen.getByTestId('agent-thread-drop-notice').textContent).toContain('Skipped'),
    );
    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(screen.getByTestId('agent-thread-drop-notice').textContent).toBe('');
  });

  test('an identical repeat drop still re-fires the notice — state carries a fresh identity so React re-runs the auto-clear effect', async () => {
    model = makeModel({ items: [], turnActive: false });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    fireDrop([makeFile('foo.ts', 'text/typescript')]);
    const notice = await screen.findByTestId('agent-thread-drop-notice');
    await vi.waitFor(() => expect(notice.textContent).toContain('Skipped'));
    fireDrop([makeFile('foo.ts', 'text/typescript')]);
    await vi.waitFor(() => expect(notice.textContent).toContain('Skipped'));
  });
});

describe('ThreadView plan approval wiring (PRD-8022)', () => {
  const plan = [{ content: 'read the files' }, { content: 'write the fix' }];

  test('Approve sends the canned English string via client.prompt', async () => {
    model = makeModel({
      plan,
      turnActive: false,
    });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    await userEvent.click(screen.getByTestId('agent-thread-plan-approval-approve'));
    expect(prompt).toHaveBeenCalledWith(
      'thread-1',
      'Approve. Please proceed with the plan.',
      undefined,
    );
  });

  test('Reject sends the canned English string via client.prompt', async () => {
    model = makeModel({
      plan,
      turnActive: false,
    });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    await userEvent.click(screen.getByTestId('agent-thread-plan-approval-reject'));
    expect(prompt).toHaveBeenCalledWith(
      'thread-1',
      'Reject. Please stop and do not proceed with this plan.',
      undefined,
    );
  });

  test('Ask changes prefills the composer without clobbering existing draft', async () => {
    model = makeModel({
      plan,
      turnActive: false,
    });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    const composer = screen.getByTestId('agent-thread-composer') as HTMLTextAreaElement;
    await userEvent.type(composer, 'hey ');
    await userEvent.click(screen.getByTestId('agent-thread-plan-approval-ask-changes'));
    // appendText: existing draft preserved, prefix joined with a blank line.
    expect(composer.value).toBe('hey\n\nIn the plan above, please ');
    // Second click: idempotent — the prefix is not duplicated.
    await userEvent.click(screen.getByTestId('agent-thread-plan-approval-ask-changes'));
    expect(composer.value).toBe('hey\n\nIn the plan above, please ');
    // client.prompt is untouched by Ask changes.
    expect(prompt).not.toHaveBeenCalled();
  });

  test('approval row hides while the thread is not ready', () => {
    model = makeModel({ plan, turnActive: true });
    render(<ThreadView info={makeInfo({ status: 'running' })} />);
    expect(screen.queryByTestId('agent-thread-plan-approval')).toBeNull();
  });

  test('approval row hides after a click until the next turn ends (double-click guard)', async () => {
    model = makeModel({ plan, turnActive: false });
    render(<ThreadView info={makeInfo({ status: 'ready' })} />);
    await userEvent.click(screen.getByTestId('agent-thread-plan-approval-approve'));
    expect(prompt).toHaveBeenCalledTimes(1);
    // Post-click: the pending flag hides the whole row so a second click has
    // nothing to hit before the status has transitioned.
    expect(screen.queryByTestId('agent-thread-plan-approval')).toBeNull();
  });

  test('approval row hides on an archived thread even with a pending plan', () => {
    model = makeModel({ plan, turnActive: false });
    render(<ThreadView info={makeInfo({ status: 'ready', archived: true })} />);
    expect(screen.queryByTestId('agent-thread-plan-approval')).toBeNull();
  });
});
