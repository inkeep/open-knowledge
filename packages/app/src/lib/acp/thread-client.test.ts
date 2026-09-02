import { readFileSync } from 'node:fs';
import type {
  ThreadEvent,
  ThreadInfo,
  ThreadServerFrame,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { describe, expect, test } from 'vitest';
import fixture from '../../../../../test-support/fixtures/codex-legacy-warning-envelopes.json' with {
  type: 'json',
};
import { AgentThreadClient, ThreadChannelUnavailableError } from './thread-client';

describe('AgentThreadClient store snapshots', () => {
  test('getThreads returns a referentially stable snapshot until the store changes', () => {
    const client = new AgentThreadClient();
    const first = client.getThreads();
    expect(client.getThreads()).toBe(first);
    expect(client.getThreads()).toBe(first);
  });

  test('getConnectionStatus is idle before any URL is set', () => {
    expect(new AgentThreadClient().getConnectionStatus()).toBe('idle');
  });
});

describe('batched event delivery', () => {
  const info: ThreadInfo = {
    threadId: 't1',
    agent: { id: 'a', name: 'A', source: 'custom' },
    title: 'A',
    status: 'ready',
    createdAt: 1,
    lastActivityAt: 1,
    modes: null,
    configOptions: null,
    lastSeq: -1,
  };
  const ev = (i: number): ThreadEvent => ({ kind: 'user_message', content: `m${i}`, ts: i });

  function makeClient(): { client: AgentThreadClient; frame: (f: ThreadServerFrame) => void } {
    const client = new AgentThreadClient();
    const internals = client as unknown as { handleFrame: (f: ThreadServerFrame) => void };
    internals.handleFrame.call(client, { op: 'subscribed', threadId: 't1', fromSeq: 0, info });
    return { client, frame: (f) => internals.handleFrame.call(client, f) };
  }

  test('an events frame appends the batch with a single store notification', () => {
    const { client, frame } = makeClient();
    let notifications = 0;
    client.subscribe(() => {
      notifications += 1;
    });
    frame({ op: 'events', threadId: 't1', fromSeq: 0, events: [ev(0), ev(1), ev(2)] });
    expect(notifications).toBe(1);
    expect(client.getThread('t1')?.events).toHaveLength(3);
    expect(client.getThread('t1')?.lastSeq).toBe(2);
  });

  test('replay overlap dedups by seq: only genuinely new events append', () => {
    const { client, frame } = makeClient();
    frame({ op: 'events', threadId: 't1', fromSeq: 0, events: [ev(0), ev(1), ev(2)] });
    frame({ op: 'events', threadId: 't1', fromSeq: 1, events: [ev(1), ev(2), ev(3)] });
    expect(client.getThread('t1')?.events).toHaveLength(4);
    expect(client.getThread('t1')?.lastSeq).toBe(3);
    let notifications = 0;
    client.subscribe(() => {
      notifications += 1;
    });
    frame({ op: 'events', threadId: 't1', fromSeq: 0, events: [ev(0)] });
    expect(notifications).toBe(0);
    expect(client.getThread('t1')?.events).toHaveLength(4);
  });

  test('single event frames still work (terminal close notice path)', () => {
    const { client, frame } = makeClient();
    frame({ op: 'event', threadId: 't1', seq: 0, event: ev(0) });
    expect(client.getThread('t1')?.events).toHaveLength(1);
    expect(client.getThread('t1')?.lastSeq).toBe(0);
  });
});

describe('queue edit settlement', () => {
  const info: ThreadInfo = {
    threadId: 't1',
    agent: { id: 'a', name: 'A', source: 'custom' },
    title: 'A',
    status: 'running',
    createdAt: 1,
    lastActivityAt: 1,
    lastSeq: -1,
  };

  function makeWiredClient(): {
    client: AgentThreadClient;
    sent: Array<Record<string, unknown>>;
    frame: (f: ThreadServerFrame) => void;
  } {
    const client = new AgentThreadClient();
    const sent: Array<Record<string, unknown>> = [];
    const internals = client as unknown as {
      ws: unknown;
      handleFrame: (f: ThreadServerFrame) => void;
    };
    internals.ws = {
      readyState: 1,
      send: (raw: string) => sent.push(JSON.parse(raw) as Record<string, unknown>),
    };
    const frame = (f: ThreadServerFrame) => internals.handleFrame.call(client, f);
    frame({ op: 'subscribed', threadId: 't1', fromSeq: 0, info });
    return { client, sent, frame };
  }

  test('the ack carrying the reqId settles the edit as applied', async () => {
    const { client, sent, frame } = makeWiredClient();
    const pending = client.editQueued('t1', 'q1', '  sharper text  ');
    const edit = sent.find((f) => f.op === 'queue_edit');
    expect(edit).toMatchObject({ threadId: 't1', id: 'q1', content: 'sharper text' });
    expect(typeof edit?.reqId).toBe('string');

    frame({ op: 'queue_edited', reqId: edit?.reqId as string, threadId: 't1' });
    await expect(pending).resolves.toBeUndefined();
  });

  test('a refusal rejects even when an unrelated info frame for the thread arrived first', async () => {
    const { client, sent, frame } = makeWiredClient();
    const pending = client.editQueued('t1', 'q1', 'too late');
    const reqId = sent.find((f) => f.op === 'queue_edit')?.reqId;
    expect(typeof reqId).toBe('string');

    frame({ op: 'info', info: { ...info, lastActivityAt: 2 } });
    frame({
      op: 'error',
      code: 'not-ready',
      message: 'queued message already dispatched',
      reqId: reqId as string,
      threadId: 't1',
    });
    await expect(pending).rejects.toThrow(/already dispatched/);
  });

  test('info frames — this thread or another — never settle the edit; the ack does', async () => {
    const { client, sent, frame } = makeWiredClient();
    let settled = false;
    const pending = client.editQueued('t1', 'q1', 'sharper text');
    void pending.then(() => {
      settled = true;
    });
    frame({ op: 'info', info: { ...info, threadId: 'other' } });
    frame({ op: 'info', info });
    frame({ op: 'queue_edited', reqId: 'queue-edit-not-mine', threadId: 't1' });
    await Promise.resolve();
    expect(settled).toBe(false);

    frame({
      op: 'queue_edited',
      reqId: sent.find((f) => f.op === 'queue_edit')?.reqId as string,
      threadId: 't1',
    });
    await expect(pending).resolves.toBeUndefined();
  });

  test('an empty edit never reaches the wire', async () => {
    const { client, sent } = makeWiredClient();
    await expect(client.editQueued('t1', 'q1', '   ')).resolves.toBeUndefined();
    expect(sent.some((f) => f.op === 'queue_edit')).toBe(false);
  });

  test('holdQueued sends the park/release frame verbatim', () => {
    const { client, sent } = makeWiredClient();
    client.holdQueued('t1', 'q1', true);
    client.holdQueued('t1', 'q1', false);
    expect(sent.filter((f) => f.op === 'queue_hold')).toEqual([
      { op: 'queue_hold', threadId: 't1', id: 'q1', held: true },
      { op: 'queue_hold', threadId: 't1', id: 'q1', held: false },
    ]);
  });
});

describe('retry and sign-in lifecycle', () => {
  const info: ThreadInfo = {
    threadId: 't1',
    agent: { id: 'a', name: 'A', source: 'custom' },
    title: 'A',
    status: 'error',
    createdAt: 1,
    lastActivityAt: 1,
    lastSeq: -1,
  };

  function makeWiredClient(): {
    client: AgentThreadClient;
    sent: Array<Record<string, unknown>>;
    frame: (f: ThreadServerFrame) => void;
  } {
    const client = new AgentThreadClient();
    const sent: Array<Record<string, unknown>> = [];
    const internals = client as unknown as {
      ws: unknown;
      handleFrame: (f: ThreadServerFrame) => void;
    };
    internals.ws = {
      readyState: 1,
      send: (raw: string) => sent.push(JSON.parse(raw) as Record<string, unknown>),
    };
    const frame = (f: ThreadServerFrame) => internals.handleFrame.call(client, f);
    frame({ op: 'subscribed', threadId: 't1', fromSeq: 0, info });
    return { client, sent, frame };
  }

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  test('retryThread sends the op and resolves with the retried thread info', async () => {
    const { client, sent, frame } = makeWiredClient();
    const pending = client.retryThread('t1');
    await flush();
    const retry = sent.find((f) => f.op === 'retry');
    expect(retry).toMatchObject({ op: 'retry', threadId: 't1' });
    expect(typeof retry?.reqId).toBe('string');

    const ready: ThreadInfo = { ...info, status: 'ready' };
    frame({ op: 'retried', reqId: retry?.reqId as string, info: ready });
    await expect(pending).resolves.toMatchObject({ status: 'ready' });
  });

  test('a retry the server refuses rejects with its message', async () => {
    const { client, sent, frame } = makeWiredClient();
    const pending = client.retryThread('t1');
    await flush();
    const reqId = sent.find((f) => f.op === 'retry')?.reqId as string;

    frame({
      op: 'error',
      code: 'spawn-failed',
      message: 'harness not installed',
      reqId,
      threadId: 't1',
    });
    await expect(pending).rejects.toThrow(/harness not installed/);
  });

  test('authenticateThread sends the method id and resolves with the signed-in info', async () => {
    const { client, sent, frame } = makeWiredClient();
    const pending = client.authenticateThread('t1', 'test_login');
    await flush();
    const auth = sent.find((f) => f.op === 'authenticate');
    expect(auth).toMatchObject({ op: 'authenticate', threadId: 't1', methodId: 'test_login' });
    expect(String(auth?.reqId)).toMatch(/^authenticate-/);

    const ready: ThreadInfo = { ...info, status: 'ready' };
    frame({ op: 'authenticated', reqId: auth?.reqId as string, info: ready });
    await expect(pending).resolves.toMatchObject({ status: 'ready' });
  });

  test('a refused sign-in rejects with what the agent said', async () => {
    const { client, sent, frame } = makeWiredClient();
    const pending = client.authenticateThread('t1', 'test_login');
    await flush();
    const reqId = sent.find((f) => f.op === 'authenticate')?.reqId as string;

    frame({ op: 'error', code: 'not-ready', message: 'wrong account', reqId, threadId: 't1' });
    await expect(pending).rejects.toThrow(/wrong account/);
  });
});

describe('createThread channel wait', () => {
  test('rejects with ThreadChannelUnavailableError when no URL is ever bound', async () => {
    const client = new AgentThreadClient();
    const waitFor = (
      client as unknown as { waitForOpen: (ms: number) => Promise<void> }
    ).waitForOpen.bind(client);
    await expect(waitFor(30)).rejects.toBeInstanceOf(ThreadChannelUnavailableError);
  });

  test('waitForOpen resolves when the channel opens during the wait', async () => {
    const client = new AgentThreadClient();
    const internals = client as unknown as {
      waitForOpen: (ms: number) => Promise<void>;
      ws: { readyState: number } | null;
      bump: () => void;
    };
    const pending = internals.waitForOpen.call(client, 1_000);
    internals.ws = { readyState: WebSocket.OPEN };
    internals.bump.call(client);
    await expect(pending).resolves.toBeUndefined();
  });
});

describe('store hooks return the useSyncExternalStore subscription value (React Compiler safety)', () => {
  const source = readFileSync(new URL('./thread-client.ts', import.meta.url), 'utf8');

  function hookBody(name: string): string {
    const start = source.indexOf(`export function ${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(open, i + 1);
      }
    }
    throw new Error(`unterminated body for ${name}`);
  }

  for (const hook of [
    'useAgentThreads',
    'useAgentThread',
    'useAgentThreadConnection',
    'useOpenAgentThreadTabs',
    'useArchivedAgentThreads',
  ]) {
    test(`${hook} returns useSyncExternalStore(...) rather than discarding it`, () => {
      const body = hookBody(hook);
      expect(body).toContain('return useSyncExternalStore(');
      expect(body).not.toMatch(/useSyncExternalStore\([^;]*\);\s*return\s+client\.get/);
    });
  }
});

describe('unread affordance (PRD-8021)', () => {
  const info: ThreadInfo = {
    threadId: 't-unread',
    agent: { id: 'a', name: 'A', source: 'custom' },
    title: 'A',
    status: 'ready',
    createdAt: 1,
    lastActivityAt: 100,
    modes: null,
    configOptions: null,
    lastSeq: -1,
  };

  function boot(): {
    client: AgentThreadClient;
    bump: (nextInfo: ThreadInfo) => void;
  } {
    const client = new AgentThreadClient();
    const internals = client as unknown as { handleFrame: (f: ThreadServerFrame) => void };
    internals.handleFrame.call(client, {
      op: 'subscribed',
      threadId: info.threadId,
      fromSeq: 0,
      info,
    });
    return {
      client,
      bump: (nextInfo) =>
        internals.handleFrame.call(client, {
          op: 'info',
          threadId: nextInfo.threadId,
          info: nextInfo,
        }),
    };
  }

  test('a fresh subscription seeds the floor to lastActivityAt — no unread pulse on reload', () => {
    const { client } = boot();
    expect(client.getThreadUnread(info.threadId)).toBe(false);
  });

  test('marks unread only after activity advances past the initial floor', () => {
    const { client, bump } = boot();
    expect(client.getThreadUnread(info.threadId)).toBe(false);
    bump({ ...info, lastActivityAt: 200 });
    expect(client.getThreadUnread(info.threadId)).toBe(true);
    client.markThreadViewed(info.threadId);
    expect(client.getThreadUnread(info.threadId)).toBe(false);
    bump({ ...info, lastActivityAt: 300 });
    expect(client.getThreadUnread(info.threadId)).toBe(true);
  });

  test('only settled `ready` tabs report unread — a running turn already pulses via its status dot', () => {
    const { client, bump } = boot();
    client.markThreadViewed(info.threadId);
    bump({ ...info, lastActivityAt: 200, status: 'running' });
    expect(client.getThreadUnread(info.threadId)).toBe(false);
    bump({ ...info, lastActivityAt: 200, status: 'ready' });
    expect(client.getThreadUnread(info.threadId)).toBe(true);
  });

  test('unknown thread reports false and never throws', () => {
    const { client } = boot();
    expect(client.getThreadUnread('not-a-thread')).toBe(false);
    client.markThreadViewed('not-a-thread');
    expect(client.getThreadUnread('not-a-thread')).toBe(false);
  });

  test('a redundant markThreadViewed does not bump the store', () => {
    const { client } = boot();
    client.markThreadViewed(info.threadId);
    let notifications = 0;
    client.subscribe(() => {
      notifications += 1;
    });
    client.markThreadViewed(info.threadId);
    expect(notifications).toBe(0);
  });

  test('mark-viewed on ready flip with unchanged activityAt clears unread', () => {
    const { client, bump } = boot();
    bump({ ...info, lastActivityAt: 200 });
    expect(client.getThreadUnread(info.threadId)).toBe(true);
    bump({ ...info, status: 'running', lastActivityAt: 200 });
    client.markThreadViewed(info.threadId);
    expect(client.getThreadUnread(info.threadId)).toBe(false);
    bump({ ...info, status: 'ready', lastActivityAt: 200 });
    client.markThreadViewed(info.threadId);
    expect(client.getThreadUnread(info.threadId)).toBe(false);
  });

  test('markThreadViewed is a no-op while the thread is `running` — no bump storm during streaming', () => {
    const { client, bump } = boot();
    bump({ ...info, status: 'running', lastActivityAt: 200 });
    let notifications = 0;
    client.subscribe(() => {
      notifications += 1;
    });
    for (let i = 1; i <= 5; i++) {
      bump({ ...info, status: 'running', lastActivityAt: 200 + i * 10 });
      client.markThreadViewed(info.threadId);
    }
    expect(notifications).toBe(5);
  });
});

describe('raw frame ingestion', () => {
  const info: ThreadInfo = {
    threadId: 'raw-1',
    agent: { id: 'codex-acp', name: 'Codex', source: 'registry' },
    title: 'Raw',
    status: 'ready',
    createdAt: 1,
    lastActivityAt: 1,
    lastSeq: -1,
  };

  test('a JSON payload lands in the store the same as a parsed frame would', () => {
    const client = new AgentThreadClient();

    client.receiveServerFrame(JSON.stringify({ op: 'info', info }));

    expect(client.getThread('raw-1')?.info.title).toBe('Raw');
  });

  test('an unparseable payload is dropped instead of thrown', () => {
    const client = new AgentThreadClient();
    client.receiveServerFrame(JSON.stringify({ op: 'info', info }));

    expect(() => client.receiveServerFrame('{ not json')).not.toThrow();
    expect(client.getThread('raw-1')?.info.title).toBe('Raw');
  });
});

describe('render-model agent identity', () => {
  const WARNING_TEXT = fixture.candidates[0].update.content.text;

  const infoFor = (agent: {
    id: string;
    name: string;
    source: 'registry' | 'custom';
  }): ThreadInfo =>
    ({
      threadId: 'ident-1',
      agent,
      title: 'Identity',
      status: 'ready',
      createdAt: 1,
      lastActivityAt: 1,
      lastSeq: -1,
    }) satisfies ThreadInfo;

  const warningEvent = (ts: number): ThreadEvent => ({
    kind: 'session_update',
    update: structuredClone(fixture.candidates[0].update) as never,
    ts,
  });

  function subscribed(agent: Parameters<typeof infoFor>[0]): AgentThreadClient {
    const client = new AgentThreadClient();
    client.receiveServerFrame(
      JSON.stringify({ op: 'subscribed', threadId: 'ident-1', fromSeq: 0, info: infoFor(agent) }),
    );
    return client;
  }

  test('a warning on a registry Codex thread reaches the view as runtime status', () => {
    const client = subscribed(fixture.agents.codexRegistry);

    client.receiveServerFrame(
      JSON.stringify({ op: 'event', threadId: 'ident-1', seq: 0, event: warningEvent(1) }),
    );

    expect(client.getThreadModel('ident-1')?.items).toEqual([
      {
        kind: 'agent_notice',
        source: 'codex_legacy',
        severity: 'warning',
        text: WARNING_TEXT,
        seq: 0,
      },
    ]);
  });

  test('the same bytes on another registry agent reach the view as prose', () => {
    const client = subscribed(fixture.agents.claudeRegistry);

    client.receiveServerFrame(
      JSON.stringify({ op: 'event', threadId: 'ident-1', seq: 0, event: warningEvent(1) }),
    );

    const items = client.getThreadModel('ident-1')?.items ?? [];
    expect(items.map((item) => item.kind)).toEqual(['message']);
    expect(items[0]).toMatchObject({ role: 'agent', text: WARNING_TEXT });
  });

  test('a replay that opens above seq 0 still stamps every notice with its wire seq', () => {
    const client = subscribed(fixture.agents.codexRegistry);

    client.receiveServerFrame(
      JSON.stringify({
        op: 'events',
        threadId: 'ident-1',
        fromSeq: 4,
        events: [warningEvent(1), warningEvent(2)],
      }),
    );

    const notices = (client.getThreadModel('ident-1')?.items ?? []).filter(
      (item) => item.kind === 'agent_notice',
    );
    expect(notices.map((item) => (item as { seq: number }).seq)).toEqual([4, 5]);
    const stored = client.getThread('ident-1');
    expect(stored?.lastSeq).toBe(5);
    expect(stored?.events.length).toBe((stored?.lastSeq ?? -1) + 1);
  });

  test('a batched replay and a live arrival of the same events agree', () => {
    const events = [warningEvent(1), warningEvent(2)];

    const live = subscribed(fixture.agents.codexRegistry);
    events.forEach((event, index) => {
      live.receiveServerFrame(
        JSON.stringify({ op: 'event', threadId: 'ident-1', seq: index, event }),
      );
    });

    const replayed = subscribed(fixture.agents.codexRegistry);
    replayed.receiveServerFrame(
      JSON.stringify({ op: 'events', threadId: 'ident-1', fromSeq: 0, events }),
    );

    expect(replayed.getThreadModel('ident-1')?.items).toEqual(
      live.getThreadModel('ident-1')?.items,
    );
    expect(replayed.getThreadModel('ident-1')?.items).toHaveLength(2);
  });
});
