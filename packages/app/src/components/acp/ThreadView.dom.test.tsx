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
  // No-op when timers are already real; makes cleanup unconditional even if a
  // test using fake timers fails before its own teardown would run.
  vi.useRealTimers();
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
  test('pins refusal left and the least-privilege grant right, with escalating grants between', () => {
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
    const deny = screen.getByTestId('agent-thread-permission-deny');
    const secondary = screen.getByTestId('agent-thread-permission-allow-more');
    const primary = screen.getByTestId('agent-thread-permission-allow');

    // Refusal first in the DOM (far left), primary grant last (far right).
    expect(deny.compareDocumentPosition(secondary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      secondary.compareDocumentPosition(primary) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Only the least-privilege grant carries primary emphasis.
    expect(primary.textContent).toBe('Allow');
    expect(primary.getAttribute('data-variant')).toBe('default');
    expect(deny.getAttribute('data-variant')).toBe('outline');
    expect(secondary.getAttribute('data-variant')).toBe('outline');

    // A lone escalating grant needs no chevron — it is directly actionable.
    expect(within(card).queryByTestId('agent-thread-permission-allow-more-more')).toBeNull();
  });

  test('collapses several escalating grants behind one secondary button', async () => {
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

    expect(screen.getByTestId('agent-thread-permission-deny').textContent).toBe('Decline');
    expect(screen.getByTestId('agent-thread-permission-allow').textContent).toBe('Allow');
    const secondary = screen.getByTestId('agent-thread-permission-allow-more');
    expect(secondary.textContent).toBe('Allow for This Session');
    // The last grant is folded away, not rendered as a fourth top-level button.
    expect(screen.queryByRole('button', { name: "Allow and Don't Ask Again" })).toBeNull();

    // The secondary button answers directly — no trip through the menu.
    await userEvent.click(secondary);
    expect(respondPermission).toHaveBeenCalledWith('thread-1', 'r1', {
      kind: 'selected',
      optionId: 'session',
    });

    // Its chevron lists every escalating grant, the button's own included.
    await userEvent.click(screen.getByTestId('agent-thread-permission-allow-more-more'));
    expect(await screen.findByRole('menuitem', { name: 'Allow for This Session' })).toBeDefined();
    fireEvent.click(screen.getByRole('menuitem', { name: "Allow and Don't Ask Again" }));
    expect(respondPermission).toHaveBeenCalledWith('thread-1', 'r1', {
      kind: 'selected',
      optionId: 'forever',
    });
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
