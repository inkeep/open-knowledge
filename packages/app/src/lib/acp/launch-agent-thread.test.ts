import { beforeEach, describe, expect, test, vi } from 'vitest';

const createThread = vi.fn();
const toastError = vi.fn((_message: string) => {});

type StoreListener = () => void;
const storeListeners = new Set<StoreListener>();
let threadCapabilities: Record<string, { image?: boolean } | null> = {};

function publishThreadUpdate(): void {
  for (const listener of storeListeners) listener();
}

vi.mock('@/lib/acp/thread-client', () => ({
  getAgentThreadClient: () => ({
    createThread,
    subscribe: (listener: StoreListener) => {
      storeListeners.add(listener);
      return () => storeListeners.delete(listener);
    },
    getThread: (threadId: string) =>
      threadId in threadCapabilities
        ? { info: { promptCapabilities: threadCapabilities[threadId] } }
        : null,
  }),
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

function startedThread(threadId: string, agentName = 'Claude Agent') {
  return { threadId, agent: { source: 'registry', id: 'claude-acp', name: agentName } };
}

const imagePart = {
  kind: 'image' as const,
  data: 'AAAA',
  mimeType: 'image/png',
  name: 'shot.png',
};

beforeEach(() => {
  createThread.mockReset();
  toastError.mockClear();
  storeListeners.clear();
  threadCapabilities = {};
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

describe('a launch carrying images the agent turns out not to accept', () => {
  test('says so once the handshake reports the capability, instead of dropping it silently', async () => {
    createThread.mockResolvedValueOnce(startedThread('cap-1'));
    await launchAgentThread(nextAgent(), 'describe this', null, null, null, [imagePart]);

    expect(toastError).not.toHaveBeenCalled();

    threadCapabilities['cap-1'] = {};
    publishThreadUpdate();

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError.mock.calls[0]?.[0]).toContain("doesn't accept image attachments");
    expect(toastError.mock.calls[0]?.[0]).toContain('Claude');
  });

  test('stays quiet when the agent does accept images', async () => {
    createThread.mockResolvedValueOnce(startedThread('cap-2'));
    await launchAgentThread(nextAgent(), 'describe this', null, null, null, [imagePart]);

    threadCapabilities['cap-2'] = { image: true };
    publishThreadUpdate();

    expect(toastError).not.toHaveBeenCalled();
    expect(storeListeners.size).toBe(0);
  });

  test('gives up the watch after the timeout, leaving no listener behind', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      createThread.mockResolvedValueOnce(startedThread('cap-timeout'));
      await launchAgentThread(nextAgent(), 'describe this', null, null, null, [imagePart]);
      expect(storeListeners.size).toBe(1);

      vi.advanceTimersByTime(60_000);

      expect(storeListeners.size).toBe(0);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      threadCapabilities['cap-timeout'] = {};
      publishThreadUpdate();
      expect(toastError).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  test('never watches a launch that carried no images', async () => {
    createThread.mockResolvedValueOnce(startedThread('cap-3'));
    await launchAgentThread(nextAgent(), 'no attachments here', null, null);

    expect(storeListeners.size).toBe(0);

    threadCapabilities['cap-3'] = {};
    publishThreadUpdate();
    expect(toastError).not.toHaveBeenCalled();
  });
});
