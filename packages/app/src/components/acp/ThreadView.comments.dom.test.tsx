/**
 * Queued review comments ride the agent panel's composer, not only the Ask AI
 * one: the same `+ Comments` chip attaches the batch, and sending puts it into
 * THIS thread as one turn rather than starting a detached conversation.
 *
 * The chip's own two-state rendering is `comment-chips`' behaviour; what this
 * suite owns is the wiring — that the row appears in the ACP composer at all,
 * that an attached batch makes an empty draft sendable, that the send reaches
 * `client.prompt` with the composed instruction, and that a hand-off which
 * never happened leaves the draft alone.
 */

import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CommentThread } from '@/comments/types';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { ThreadRenderModel } from '@/lib/acp/thread-event-model';
import { MockComposerMentionInput } from './composer-mention-input.test-helper';

const render = (ui: Parameters<typeof rtlRender>[0]) => rtlRender(ui, { wrapper: TooltipProvider });

const prompt = vi.fn((_threadId: string, _content: string) => {});
const createThread = vi.fn((_args: { prompt?: string }) => Promise.resolve({ threadId: 'new' }));
/**
 * Archived-thread resume, controlled per test.
 *
 * The ONLY send that can genuinely fail: a live thread's `prompt` is a
 * fire-and-forget call the server queues, so every failure assertion below runs
 * against an archived thread.
 */
let resumeSucceeds = false;
const resumeThread = vi.fn((_threadId: string, _content: string) =>
  resumeSucceeds ? Promise.resolve(undefined) : Promise.reject(new Error('agent session is gone')),
);

vi.doMock('@/lib/acp/thread-client', () => ({
  getAgentThreadClient: () => ({
    respondPermission: () => {},
    respondRuntimeConsent: () => {},
    cancel: () => {},
    prompt,
    editQueued: () => {},
    removeQueued: () => {},
    setMode: () => {},
    setConfigOption: () => {},
    closeThread: () => {},
    createThread,
    resumeThread,
  }),
  ThreadResumeError: class ThreadResumeError extends Error {},
  useAgentThread: () => ({ info: undefined, events: [], lastSeq: 5 }),
  useAgentThreadModel: () => model,
}));

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ systemProvider: null }),
}));

vi.doMock('@/lib/use-workspace', () => ({ useWorkspace: () => null }));

vi.doMock('@/components/acp/AgentMarkdown', () => ({
  AgentMarkdown: ({ text }: { text: string }) => <div>{text}</div>,
}));

// The composer's rich input, doubled as a textarea (jsdom can't type into a
// ProseMirror contentEditable) — see the helper's header for contract parity.
vi.doMock('@/editor/ComposerMentionInput', () => ({
  ComposerMentionInput: MockComposerMentionInput,
}));

/**
 * The comment store, doubled: a fixed queue with everything checked. The real
 * one talks to the server on every read, and the dispatch path's server-side
 * re-anchor is `dispatch-batch.test.ts`'s subject, not this suite's.
 */
const captured = {
  dispatched: [] as string[],
  selectAllCalls: 0,
  /** Whether each send asked for the batch to be closed. */
  resolved: [] as boolean[],
};

function thread(id: string, docName: string, body: string): CommentThread {
  return {
    id,
    docName,
    target: { kind: 'body' },
    anchor: { quote: `quote for ${id}`, prefix: '', suffix: '', start: 0, end: 5 },
    status: 'open',
    body,
    createdAt: 1,
    queued: true,
  };
}

const threads = [
  thread('t1', 'notes.md', 'tighten this'),
  thread('t2', 'plan.md', 'cite a source'),
];

vi.doMock('@/comments/store', () => ({
  useQueue: () => threads.map((item) => item.id),
  useQueueSelection: () => threads.map((item) => item.id),
  getThreadById: (id: string) => threads.find((item) => item.id === id) ?? null,
  removeFromQueue: () => {},
  toggleQueueSelection: () => {},
  selectAllQueued: () => {
    captured.selectAllCalls += 1;
  },
  dispatchComments: async ({
    compose,
    resolve = true,
  }: {
    compose: (items: readonly { threadId: string; payload: unknown }[]) => Promise<boolean>;
    resolve?: boolean;
  }) => {
    captured.resolved.push(resolve);
    const items = threads.map((item) => ({
      threadId: item.id,
      payload: {
        docName: item.docName,
        instruction: item.body,
        passage: { exact: item.anchor?.quote ?? '', prefix: '', suffix: '' },
        anchorLost: false,
        passageRepeats: false,
      },
    }));
    // What ships is what `compose` reported, exactly as the real dispatch path
    // decides it. Returning a preset list instead would let the send's own
    // boolean go untested — and that boolean is the whole contract here: a
    // hand-off that never happened must leave every comment queued.
    const delivered = await compose(items);
    if (!delivered) return [];
    const ids = items.map((item) => item.threadId);
    captured.dispatched.push(...ids);
    return ids;
  },
}));

const { ThreadView } = await import('./ThreadView');

let model: ThreadRenderModel | null = null;

function makeInfo(overrides?: Partial<ThreadInfo>): ThreadInfo {
  return {
    threadId: 'thread-1',
    agent: { id: 'claude', name: 'Claude Agent', source: 'registry' },
    title: 'Test thread',
    status: 'ready',
    createdAt: 1,
    lastActivityAt: 2,
    lastSeq: 5,
    archived: false,
    ...overrides,
  };
}

beforeEach(() => {
  model = {
    items: [],
    plan: [],
    turnActive: false,
    tokenUsage: null,
    terminals: {},
    permissionsByToolCall: {},
  };
  prompt.mockClear();
  createThread.mockClear();
  resumeThread.mockClear();
  captured.dispatched = [];
  captured.selectAllCalls = 0;
  captured.resolved = [];
  resumeSucceeds = false;
});

afterEach(cleanup);

describe('ThreadView queued-comment chip', () => {
  test('offers the queue as an add chip, then names what the message carries', async () => {
    const user = userEvent.setup();
    render(<ThreadView info={makeInfo()} />);

    // Detached: the source, with no count — the chip's presence is the signal
    // that a batch is waiting.
    const chip = screen.getByTestId('composer-context-chip-comments');
    expect(chip.textContent).toContain('Comments');
    expect(chip.textContent).not.toContain('2');

    await user.click(chip);

    expect(captured.selectAllCalls).toBe(1);
    expect(screen.getByTestId('composer-context-chip-comments').textContent).toContain(
      '2 comments',
    );
  });

  test('an attached batch is sendable with nothing typed, and lands as one prompt', async () => {
    const user = userEvent.setup();
    render(<ThreadView info={makeInfo()} />);

    const send = screen.getByTestId('agent-thread-send') as HTMLButtonElement;
    // Empty draft, nothing attached: there is nothing to send.
    expect(send.disabled).toBe(true);

    await user.click(screen.getByTestId('composer-context-chip-comments'));
    expect(send.disabled).toBe(false);

    await user.click(send);

    expect(prompt).toHaveBeenCalledTimes(1);
    const [threadId, content] = prompt.mock.calls[0] ?? [];
    expect(threadId).toBe('thread-1');
    // One turn carrying both comments, each naming its own document.
    expect(content).toContain('notes.md');
    expect(content).toContain('tighten this');
    expect(content).toContain('plan.md');
    expect(content).toContain('cite a source');
    expect(captured.dispatched).toEqual(['t1', 't2']);
    // The turn ran, so the comments close with it.
    expect(captured.resolved).toEqual([true]);
  });

  test('the typed draft becomes the batch instruction and clears on a real send', async () => {
    const user = userEvent.setup();
    render(<ThreadView info={makeInfo()} />);

    const field = screen.getByTestId('agent-thread-composer') as HTMLTextAreaElement;
    await user.click(field);
    await user.keyboard('apply these before the review');
    await user.click(screen.getByTestId('composer-context-chip-comments'));
    await user.click(screen.getByTestId('agent-thread-send'));

    expect(prompt.mock.calls[0]?.[1]).toContain('apply these before the review');
    expect(field.value).toBe('');
    // The batch detaches with the draft, so the next message can't silently
    // carry whatever has been queued since.
    expect(screen.getByTestId('composer-context-chip-comments').textContent).toContain('Comments');
  });

  test('a mid-turn send queues the message but leaves the comments open', async () => {
    // A turn is running, so the send lands in the server's message queue — and
    // a cancel or a dead agent drops that queue before it is ever read.
    model = { ...(model as ThreadRenderModel), turnActive: true };
    const user = userEvent.setup();
    render(<ThreadView info={makeInfo({ status: 'running' })} />);

    await user.click(screen.getByTestId('composer-context-chip-comments'));
    await user.click(screen.getByTestId('agent-thread-send'));

    // The message really is sent...
    expect(prompt).toHaveBeenCalledTimes(1);
    // ...but nothing is marked done until the agent picks it up.
    expect(captured.resolved).toEqual([false]);
  });

  test('a resumed archived thread ships the batch like any other send', async () => {
    resumeSucceeds = true;
    const user = userEvent.setup();
    render(<ThreadView info={makeInfo({ archived: true })} />);

    const field = screen.getByTestId('agent-thread-composer') as HTMLTextAreaElement;
    await user.click(field);
    await user.keyboard('handle these');
    await user.click(screen.getByTestId('composer-context-chip-comments'));
    await user.click(screen.getByTestId('agent-thread-send'));

    // The message rides the resume op as the thread's first turn.
    expect(resumeThread.mock.calls[0]?.[1]).toContain('tighten this');
    await waitFor(() => expect(captured.dispatched).toEqual(['t1', 't2']));
    await waitFor(() => expect(field.value).toBe(''));
  });

  test('a send that failed leaves the batch attached and the draft intact', async () => {
    const user = userEvent.setup();
    render(<ThreadView info={makeInfo({ archived: true })} />);

    const field = screen.getByTestId('agent-thread-composer') as HTMLTextAreaElement;
    await user.click(field);
    await user.keyboard('handle these');
    await user.click(screen.getByTestId('composer-context-chip-comments'));
    await user.click(screen.getByTestId('agent-thread-send'));

    await screen.findByTestId('agent-thread-resume-failed');
    // Nothing resolved: the comments are all still queued, still on this
    // message, and the words typed for them are where they were left.
    expect(captured.dispatched).toEqual([]);
    expect(field.value).toBe('handle these');
    expect(screen.getByTestId('composer-context-chip-comments').textContent).toContain(
      '2 comments',
    );
  });

  test('a failed resume never hands the composed batch to the new-thread fallback', async () => {
    const user = userEvent.setup();
    render(<ThreadView info={makeInfo({ archived: true })} />);

    const field = screen.getByTestId('agent-thread-composer') as HTMLTextAreaElement;
    await user.click(field);
    await user.keyboard('look at these');
    await user.click(screen.getByTestId('composer-context-chip-comments'));
    await user.click(screen.getByTestId('agent-thread-send'));

    // The resume itself carried the batch — that send was real, it just failed.
    expect(resumeThread.mock.calls[0]?.[1]).toContain('tighten this');

    await user.click(await screen.findByTestId('agent-thread-resume-fallback-new'));

    // The fresh thread starts from the reviewer's own words. Carrying the
    // composed batch here would run it while the same comments sit queued,
    // ready to ride a later send too.
    const started = createThread.mock.calls[0]?.[0];
    expect(started?.prompt).toBe('look at these');
    expect(started?.prompt).not.toContain('tighten this');
  });
});
