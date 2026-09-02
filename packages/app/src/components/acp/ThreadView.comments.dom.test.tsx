import type { ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { CommentThread } from '@/comments/types';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { ThreadRenderModel } from '@/lib/acp/thread-event-model';
import { MockComposerMentionInput } from './composer-mention-input.test-helper';

const render = (ui: Parameters<typeof rtlRender>[0]) => rtlRender(ui, { wrapper: TooltipProvider });

const prompt = vi.fn((_threadId: string, _content: string) => {});
const createThread = vi.fn((_args: { prompt?: string }) => Promise.resolve({ threadId: 'new' }));
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

vi.doMock('@/editor/ComposerMentionInput', () => ({
  ComposerMentionInput: MockComposerMentionInput,
}));

const captured = {
  dispatched: [] as string[],
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
    updatedAt: 1,
    queued: true,
  };
}

const threads = [
  thread('t1', 'notes.md', 'tighten this'),
  thread('t2', 'plan.md', 'cite a source'),
];

const commentPostedListeners = new Set<() => void>();
function emitCommentPostedForTest() {
  for (const listener of commentPostedListeners) listener();
}

vi.doMock('@/comments/store', () => ({
  useQueueSelection: () => threads.map((item) => item.id),
  getThreadById: (id: string) => threads.find((item) => item.id === id) ?? null,
  removeFromQueue: () => {},
  toggleQueueSelection: () => {},
  subscribeCommentPosted: (listener: () => void) => {
    commentPostedListeners.add(listener);
    return () => commentPostedListeners.delete(listener);
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
  captured.resolved = [];
  resumeSucceeds = false;
  commentPostedListeners.clear();
});

afterEach(cleanup);

describe('ThreadView queued-comment chip', () => {
  test('names what the message carries, with no attach step', async () => {
    const user = userEvent.setup();
    render(<ThreadView info={makeInfo()} />);

    expect(screen.getByTestId('composer-context-chip-comments').textContent).toContain(
      '2 comments',
    );

    await user.click(screen.getByRole('button', { name: /leave these comments out/i }));
    const detached = screen.getByTestId('composer-context-chip-comments');
    expect(detached.textContent).toContain('Comments');
    expect(detached.textContent).not.toContain('2 comments');
    expect((screen.getByTestId('agent-thread-send') as HTMLButtonElement).disabled).toBe(true);

    await user.click(detached);
    expect(screen.getByTestId('composer-context-chip-comments').textContent).toContain(
      '2 comments',
    );
  });

  test('posting a new comment re-attaches a dismissed batch', async () => {
    const user = userEvent.setup();
    render(<ThreadView info={makeInfo()} />);

    await user.click(screen.getByRole('button', { name: /leave these comments out/i }));
    expect(screen.getByTestId('composer-context-chip-comments').textContent).not.toContain(
      '2 comments',
    );

    act(() => emitCommentPostedForTest());

    expect(screen.getByTestId('composer-context-chip-comments').textContent).toContain(
      '2 comments',
    );
  });

  test('a ticked batch is sendable with nothing typed, and lands as one prompt', async () => {
    const user = userEvent.setup();
    render(<ThreadView info={makeInfo()} />);

    const send = screen.getByTestId('agent-thread-send') as HTMLButtonElement;
    expect(send.disabled).toBe(false);

    await user.click(send);

    expect(prompt).toHaveBeenCalledTimes(1);
    const [threadId, content] = prompt.mock.calls[0] ?? [];
    expect(threadId).toBe('thread-1');
    expect(content).toContain('notes.md');
    expect(content).toContain('tighten this');
    expect(content).toContain('plan.md');
    expect(content).toContain('cite a source');
    expect(captured.dispatched).toEqual(['t1', 't2']);
    expect(captured.resolved).toEqual([true]);
  });

  test('the typed draft becomes the batch instruction and clears on a real send', async () => {
    const user = userEvent.setup();
    render(<ThreadView info={makeInfo()} />);

    const field = screen.getByTestId('agent-thread-composer') as HTMLTextAreaElement;
    await user.click(field);
    await user.keyboard('apply these before the review');
    await user.click(screen.getByTestId('agent-thread-send'));

    expect(prompt.mock.calls[0]?.[1]).toContain('apply these before the review');
    expect(field.value).toBe('');
    expect(screen.getByTestId('composer-context-chip-comments').textContent).toContain(
      '2 comments',
    );
  });

  test('a mid-turn send queues the message but leaves the comments open', async () => {
    model = { ...(model as ThreadRenderModel), turnActive: true };
    const user = userEvent.setup();
    render(<ThreadView info={makeInfo({ status: 'running' })} />);

    await user.click(screen.getByTestId('agent-thread-send'));

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(captured.resolved).toEqual([false]);
  });

  test('a resumed archived thread ships the batch like any other send', async () => {
    resumeSucceeds = true;
    const user = userEvent.setup();
    render(<ThreadView info={makeInfo({ archived: true })} />);

    const field = screen.getByTestId('agent-thread-composer') as HTMLTextAreaElement;
    await user.click(field);
    await user.keyboard('handle these');
    await user.click(screen.getByTestId('agent-thread-send'));

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
    await user.click(screen.getByTestId('agent-thread-send'));

    await screen.findByTestId('agent-thread-resume-failed');
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
    await user.click(screen.getByTestId('agent-thread-send'));

    expect(resumeThread.mock.calls[0]?.[1]).toContain('tighten this');

    await user.click(await screen.findByTestId('agent-thread-resume-fallback-new'));

    const started = createThread.mock.calls[0]?.[0];
    expect(started?.prompt).toBe('look at these');
    expect(started?.prompt).not.toContain('tighten this');
  });
});
