/**
 * RTL mount tests for the thread-rendering parity surfaces: the terminal
 * card (command + output + exit badge), the genuine line diff, the explicit
 * Deny path and kind-aware resolution summaries, dead-turn permission
 * gating, the awaiting-permission transcript line, the context-usage ring
 * (shown only once a percentage is computable), and the raw tool-input block.
 * Invocation via `bun run test:dom`.
 */

import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { cleanup, fireEvent, render as rtlRender, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type {
  RenderedItem,
  RenderedTerminal,
  ThreadRenderModel,
} from '@/lib/acp/thread-event-model';

// ThreadView renders Radix Tooltips (the context-usage ring, the follow
// toggle). The app installs the single TooltipProvider at its root (main.tsx),
// so mount tests must supply one or Radix throws "`Tooltip` must be used
// within `TooltipProvider`".
const render = (ui: Parameters<typeof rtlRender>[0]) => rtlRender(ui, { wrapper: TooltipProvider });

let model: ThreadRenderModel | null = null;
const respondPermission = vi.fn((_threadId: string, _requestId: string, _outcome: unknown) => {});
const setConfigOption = vi.fn(
  (_threadId: string, _configId: string, _value: string | boolean) => {},
);
const setMode = vi.fn((_threadId: string, _modeId: string) => {});

vi.doMock('@/lib/acp/thread-client', () => ({
  getAgentThreadClient: () => ({
    respondPermission,
    respondRuntimeConsent: () => {},
    cancel: () => {},
    prompt: () => {},
    setMode,
    setConfigOption,
    closeThread: () => {},
    createThread: async () => {
      throw new Error('unused');
    },
    resumeThread: async () => {
      throw new Error('unused');
    },
  }),
  ThreadResumeError: class ThreadResumeError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  useAgentThread: () => ({ info: undefined, events: [], lastSeq: 5 }),
  useAgentThreadModel: () => model,
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
  AgentMarkdown: ({ text }: { text: string }) => <div>{text}</div>,
}));

const { ThreadView } = await import('./ThreadView');

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
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  respondPermission.mockClear();
  setConfigOption.mockClear();
  setMode.mockClear();
  model = null;
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

    // Open the Model submenu and pick Opus. Radix menu items select on the
    // `click` event (handleSelect), which fireEvent dispatches directly;
    // userEvent's pointer sequence instead trips Radix's submenu grace logic
    // and never fires the RadioGroup's onValueChange.
    await userEvent.click(modelRow);
    fireEvent.click(await screen.findByTestId('agent-thread-config-option-opus'));
    expect(setConfigOption).toHaveBeenCalledWith('thread-1', 'model', 'opus');
  });

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
    // open it and pick Ask. fireEvent for the radio select — see the Model
    // submenu note above on why userEvent doesn't fire onValueChange.
    await userEvent.click(screen.getByTestId('agent-thread-config-legacy-mode'));
    fireEvent.click(await screen.findByTestId('agent-thread-config-option-ask'));
    expect(setMode).toHaveBeenCalledWith('thread-1', 'ask');
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

  test('a failing command shows a destructive exit badge; ANSI is stripped', () => {
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
    const badge = screen.getByTestId('agent-thread-terminal-exit');
    expect(badge.textContent).toBe('exit 3');
    const card = screen.getByTestId('agent-thread-terminal');
    expect(card.textContent).toContain('FAIL assertion');
    expect(card.textContent).not.toContain('[31m');
  });

  test('a still-running terminal shows no exit badge', () => {
    model = makeModel({
      items: [toolCall({ terminalIds: ['t1'] })],
      terminals: { t1: terminal({ exit: null }) },
    });
    render(<ThreadView info={makeInfo()} />);
    expect(screen.getByTestId('agent-thread-terminal').textContent).toContain('running');
    expect(screen.queryByTestId('agent-thread-terminal-exit')).toBeNull();
  });
});

describe('ThreadView inline diff', () => {
  test('unchanged lines render once as context, not as remove+add pairs', () => {
    model = makeModel({
      items: [
        toolCall({
          status: 'in_progress',
          diffs: [{ path: 'notes.md', oldText: 'same\nold\n', newText: 'same\nnew\n' }],
        }),
      ],
    });
    render(<ThreadView info={makeInfo()} />);
    const transcript = screen.getByTestId('agent-thread-transcript');
    const occurrences = (transcript.textContent?.match(/same/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(transcript.textContent).toContain('- old');
    expect(transcript.textContent).toContain('+ new');
  });

  test('long unchanged runs collapse into a gap row', () => {
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
    expect(screen.getByTestId('agent-thread-transcript').textContent).toContain('unchanged lines');
  });
});

describe('ThreadView permissions', () => {
  test('stacks choices in least-privilege order with one primary action', () => {
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
    const buttons = within(card).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Allow',
      'Always allow all mcp__open-knowledge__exec',
      'Deny',
    ]);
    expect(buttons.map((button) => button.getAttribute('data-variant'))).toEqual([
      'default',
      'outline',
      'outline',
    ]);
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

  test('offers no extra Deny when the agent already has a reject option', () => {
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
    expect(screen.queryByTestId('agent-thread-permission-deny')).toBeNull();
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

describe('ThreadView raw input', () => {
  test('collapses raw tool input by default and reveals it on request', async () => {
    model = makeModel({
      items: [toolCall({ rawInput: { docName: 'notes/today', position: 'append' } })],
    });
    render(<ThreadView info={makeInfo()} />);
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
