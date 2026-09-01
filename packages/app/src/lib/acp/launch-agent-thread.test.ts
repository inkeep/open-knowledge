import { beforeEach, describe, expect, test, vi } from 'vitest';

const createThread = vi.fn();
const toastError = vi.fn((_message: string) => {});

vi.mock('@/lib/acp/thread-client', () => ({
  getAgentThreadClient: () => ({ createThread }),
  ThreadChannelUnavailableError: class extends Error {},
}));
vi.mock('@/lib/acp/thread-draft-staging', () => ({ stageThreadDraft: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastError, info: vi.fn(), success: vi.fn() } }));

const { launchAgentThread } = await import('@/lib/acp/launch-agent-thread');

let agentSeq = 0;
function nextAgent(): { source: 'registry'; id: string } {
  agentSeq += 1;
  return { source: 'registry', id: `agent-${agentSeq}` };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  createThread.mockReset();
  toastError.mockClear();
});

describe('launchAgentThread dedup guard', () => {
  test('a second launch for the same agent while one is in flight is dropped, not duplicated', async () => {
    const agent = nextAgent();
    const first = deferred<{ threadId: string }>();
    createThread.mockReturnValueOnce(first.promise);

    const inFlight = launchAgentThread(agent, 'first prompt', null, null);
    const collided = await launchAgentThread(agent, 'second prompt', null, null);

    expect(collided).toBe('deduped');
    expect(createThread).toHaveBeenCalledTimes(1);

    first.resolve({ threadId: 't1' });
    expect(await inFlight).toBe('started');
  });

  test('a different agent is never blocked by the first one', async () => {
    const held = deferred<{ threadId: string }>();
    createThread.mockReturnValue(held.promise);
    const first = launchAgentThread(nextAgent(), 'prompt', null, null);
    const other = launchAgentThread(nextAgent(), 'prompt', null, null);

    expect(createThread).toHaveBeenCalledTimes(2);
    held.resolve({ threadId: 't1' });
    expect(await first).toBe('started');
    expect(await other).toBe('started');
  });

  test('the key is released once a launch settles — on success', async () => {
    const agent = nextAgent();
    createThread.mockResolvedValueOnce({ threadId: 't1' });
    expect(await launchAgentThread(agent, 'prompt', null, null)).toBe('started');

    createThread.mockResolvedValueOnce({ threadId: 't2' });
    expect(await launchAgentThread(agent, 'prompt', null, null)).toBe('started');
    expect(createThread).toHaveBeenCalledTimes(2);
  });

  test('the key is released once a launch settles — on failure too', async () => {
    const agent = nextAgent();
    createThread.mockRejectedValueOnce(new Error('spawn failed'));
    expect(await launchAgentThread(agent, 'prompt', null, null)).toBe('failed');
    expect(toastError).toHaveBeenCalled();

    createThread.mockResolvedValueOnce({ threadId: 't2' });
    expect(await launchAgentThread(agent, 'prompt', null, null)).toBe('started');
  });
});
