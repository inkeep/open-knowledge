import type {
  SessionUpdate,
  ThreadAgentInfo,
  ThreadInfo,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MockComposerMentionInput } from '@/components/acp/composer-mention-input.test-helper';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DEV_HARNESS_SENTINEL } from '../../../scripts/check-dev-harness-absent.mjs';
import { type AcpThreadHarness, installAcpThreadHarness } from './dev-thread-harness';
import { AgentThreadClient } from './thread-client';
import type { RenderedItem } from './thread-event-model';

vi.doMock('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ systemProvider: null }),
}));
vi.doMock('@/lib/use-workspace', () => ({ useWorkspace: () => null }));
vi.doMock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.doMock('@/editor/ComposerMentionInput', () => ({
  ComposerMentionInput: MockComposerMentionInput,
}));

const { ThreadView } = await import('@/components/acp/ThreadView');
const { getAgentThreadClient } = await import('./thread-client');

const CODEX: ThreadAgentInfo = { id: 'codex-acp', name: 'Codex', source: 'registry' };
const CLAUDE: ThreadAgentInfo = { id: 'claude-acp', name: 'Claude Agent', source: 'registry' };

function chunk(text: string): SessionUpdate {
  return {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
  } as SessionUpdate;
}

function isMessage(item: RenderedItem): item is Extract<RenderedItem, { kind: 'message' }> {
  return item.kind === 'message';
}

function messageTexts(client: AgentThreadClient, threadId: string): string[] {
  return (client.getThreadModel(threadId)?.items ?? []).filter(isMessage).map((item) => item.text);
}

function takeHarness(): AcpThreadHarness {
  const installed = window.__acpThreadHarness;
  if (installed === undefined) throw new Error('harness did not install');
  return installed;
}

describe('injected frames reach the store through the socket path', () => {
  let client: AgentThreadClient;
  let harness: AcpThreadHarness;
  let uninstall: () => void;

  beforeEach(() => {
    client = new AgentThreadClient();
    uninstall = installAcpThreadHarness(client);
    harness = takeHarness();
  });

  afterEach(() => {
    uninstall();
  });

  test('an opened thread carries the agent identity it was given', () => {
    const threadId = harness.openThread({ agent: CODEX, title: 'Codex session' });

    const info = client.getThread(threadId)?.info;
    expect(info?.agent).toEqual(CODEX);
    expect(info?.title).toBe('Codex session');
  });

  test('two threads can run different agents at once', () => {
    const codexThread = harness.openThread({ agent: CODEX });
    const claudeThread = harness.openThread({ agent: CLAUDE });

    expect(client.getThread(codexThread)?.info.agent.id).toBe('codex-acp');
    expect(client.getThread(claudeThread)?.info.agent.id).toBe('claude-acp');
  });

  test('live updates fold into transcript messages in arrival order', () => {
    const threadId = harness.openThread({ agent: CODEX });

    harness.pushUpdates(threadId, [chunk('first '), chunk('second')]);

    expect(messageTexts(client, threadId)).toEqual(['first second']);
  });

  test('a replayed transcript folds identically to the same updates arriving live', () => {
    const updates = [chunk('alpha'), chunk('beta')];
    const liveThread = harness.openThread({ agent: CODEX });
    harness.pushUpdates(liveThread, updates);

    const replayedThread = harness.replayThread({ agent: CODEX }, updates);

    expect(messageTexts(client, replayedThread)).toEqual(messageTexts(client, liveThread));
  });

  test('a live update after a replay continues the same transcript', () => {
    const threadId = harness.replayThread({ agent: CODEX }, [chunk('history')]);

    harness.pushUpdates(threadId, [chunk(' and more')]);

    expect(messageTexts(client, threadId)).toEqual(['history and more']);
  });

  test('a replay announces the retained log it is about to deliver', () => {
    const updates = [chunk('alpha'), chunk('beta'), chunk('gamma')];

    const threadId = harness.replayThread({ agent: CODEX }, updates);

    const state = client.getThread(threadId);
    expect(state?.info.lastSeq).toBe(updates.length - 1);
    expect(state?.lastSeq).toBe(updates.length - 1);
    expect(client.getThread(harness.openThread({ agent: CODEX }))?.info.lastSeq).toBe(-1);
  });

  test('a raw frame is dispatched verbatim', () => {
    const threadId = harness.openThread({ agent: CODEX });

    harness.frame({
      op: 'event',
      threadId,
      seq: 0,
      event: { kind: 'title_changed', title: 'Renamed by frame', ts: 1 },
    });

    expect(client.getThread(threadId)?.info.title).toBe('Renamed by frame');
  });

  test('reset drops injected threads and leaves server-owned ones alone', () => {
    const serverThread: ThreadInfo = {
      threadId: 'from-server',
      agent: CLAUDE,
      title: 'Real thread',
      status: 'ready',
      createdAt: 1,
      lastActivityAt: 1,
      lastSeq: -1,
    };
    harness.frame({ op: 'info', info: serverThread });
    const injected = harness.openThread({ agent: CODEX });

    harness.reset();

    expect(client.getThread(injected)).toBeNull();
    expect(client.getThread('from-server')?.info.title).toBe('Real thread');
  });

  test('uninstalling withdraws the harness from the window', () => {
    uninstall();

    expect(window.__acpThreadHarness).toBeUndefined();
  });

  test('publishes itself on the exact global the production-artifact gate scans for', () => {
    expect(Reflect.get(window, DEV_HARNESS_SENTINEL)).toBe(harness);
  });
});

describe('injected frames reach the mounted transcript', () => {
  let harness: AcpThreadHarness;
  let uninstall: () => void;

  beforeEach(() => {
    uninstall = installAcpThreadHarness(getAgentThreadClient());
    harness = takeHarness();
  });

  afterEach(() => {
    harness.reset();
    uninstall();
    cleanup();
  });

  test('an injected agent message paints in the transcript', async () => {
    const threadId = harness.openThread({ agent: CODEX, title: 'Injected' });
    harness.pushUpdates(threadId, [chunk('Injected answer body.')]);
    const info = getAgentThreadClient().getThread(threadId)?.info;
    if (info === undefined) throw new Error('thread missing from the client');

    render(
      <TooltipProvider>
        <ThreadView info={info} active />
      </TooltipProvider>,
    );

    expect(await screen.findByText('Injected answer body.')).toBeTruthy();
  });

  test('a replayed transcript paints the same body as a live arrival', async () => {
    const threadId = harness.replayThread({ agent: CODEX, title: 'Replayed' }, [
      chunk('Replayed answer body.'),
    ]);
    const info = getAgentThreadClient().getThread(threadId)?.info;
    if (info === undefined) throw new Error('thread missing from the client');

    render(
      <TooltipProvider>
        <ThreadView info={info} active />
      </TooltipProvider>,
    );

    expect(await screen.findByText('Replayed answer body.')).toBeTruthy();
  });
});
