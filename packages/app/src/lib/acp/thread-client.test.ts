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

/**
 * Regression coverage for the agent-thread store hooks.
 *
 * These hooks feed `useSyncExternalStore`, and the app builds with React
 * Compiler enabled. A hook that CALLS `useSyncExternalStore(...)` for its
 * subscription but then returns a *separate* `client.getX()` (discarding the
 * subscription result) has no reactive input the compiler can see, so the
 * compiler memoizes the hook's return value to the first — empty — snapshot and
 * the UI never updates. That exact shape once shipped and made the agent-thread
 * dock never display created threads.
 *
 * The compiler runs at BUILD time, not under `bun test`, so a render test can't
 * catch it — a broken hook still "works" in the test env. Hence the two guards
 * below: a runtime check that the store getter is a stable snapshot (the
 * property the fix relies on) and a source check that each hook returns the
 * `useSyncExternalStore` value directly.
 */

describe('AgentThreadClient store snapshots', () => {
  test('getThreads returns a referentially stable snapshot until the store changes', () => {
    const client = new AgentThreadClient();
    const first = client.getThreads();
    // A fresh `[...].map()` on every call would loop useSyncExternalStore and, with
    // React Compiler on, let the hook memoize the first snapshot forever. The
    // getter must return the same reference while the store version is unchanged.
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
    // Overlapping window (a flush racing a replay) — only seq 3 is new.
    frame({ op: 'events', threadId: 't1', fromSeq: 1, events: [ev(1), ev(2), ev(3)] });
    expect(client.getThread('t1')?.events).toHaveLength(4);
    expect(client.getThread('t1')?.lastSeq).toBe(3);
    // A fully-stale frame is a no-op — no bump, no growth.
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

  /** Client with a stub socket, so sent frames are observable. */
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
    // The reqId is what makes both the ack and a refusal answerable at all.
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

    // The regression: a batched `info` (a turn ending, a status flip) reaches
    // the client before the server's refusal. Settling on it would report the
    // edit as applied and leave the error with nowhere to go.
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
    // An ack for a different edit is just as inert.
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

  /** Client with a stub socket, so sent frames are observable. */
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

  /** Both ops await `waitForOpen` before sending, so the frame lands a tick later. */
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
    // The prefix is what an error frame is correlated by — it must not collide
    // with another op's namespace.
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
    // Private-field poke: shrink the wait so the test doesn't sit out the
    // full production timeout. The wait path itself is what's under test.
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
    // Simulate the socket transitioning to OPEN, then any store bump (the
    // real client bumps via setStatus('open')).
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
      // Must return the subscription result…
      expect(body).toContain('return useSyncExternalStore(');
      // …and must NOT call it as a bare statement and then return a separate
      // store read (the shape the React Compiler memoizes into staleness).
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
    // Contract: the pulse means "advanced while you were elsewhere in
    // THIS window session", not "you just reloaded". The floor is seeded
    // to whatever activity the thread already had when we first learned
    // about it, so a renderer reload does not fabricate an unread state
    // for every idle ready tab.
    const { client } = boot();
    expect(client.getThreadUnread(info.threadId)).toBe(false);
  });

  test('marks unread only after activity advances past the initial floor', () => {
    const { client, bump } = boot();
    // Fresh state (floor seeded): no unread.
    expect(client.getThreadUnread(info.threadId)).toBe(false);
    // Activity moves — unread turns on.
    bump({ ...info, lastActivityAt: 200 });
    expect(client.getThreadUnread(info.threadId)).toBe(true);
    // Viewing clears it until the next bump.
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
    // idempotent no-op on unknown ids
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
    // Reviewer regression: a `running → ready` transition may carry no
    // fresh activityAt (an info frame that only flips status). The
    // SessionsHost effect keys on status changes too, so markThreadViewed
    // must still clear unread when the caller re-fires on that flip.
    const { client, bump } = boot();
    bump({ ...info, lastActivityAt: 200 });
    expect(client.getThreadUnread(info.threadId)).toBe(true);
    // Running interlude — activityAt stays at 200.
    bump({ ...info, status: 'running', lastActivityAt: 200 });
    client.markThreadViewed(info.threadId); // no-op under running
    expect(client.getThreadUnread(info.threadId)).toBe(false); // running always reads false
    // Flip back to ready with the SAME activityAt.
    bump({ ...info, status: 'ready', lastActivityAt: 200 });
    // Mark once more (what the effect's status-dep firing does).
    client.markThreadViewed(info.threadId);
    expect(client.getThreadUnread(info.threadId)).toBe(false);
  });

  test('markThreadViewed is a no-op while the thread is `running` — no bump storm during streaming', () => {
    // The SessionsHost mark-viewed effect keys on lastActivityAt, which
    // every streaming event bumps. If markThreadViewed also bumped for
    // each of those, the version-keyed snapshot cache would invalidate
    // once per event and every store subscriber would re-render. The
    // guard collapses those to zero bumps until the turn settles.
    const { client, bump } = boot();
    bump({ ...info, status: 'running', lastActivityAt: 200 });
    let notifications = 0;
    client.subscribe(() => {
      notifications += 1;
    });
    // Simulate five streaming batches, mark-viewed after each.
    for (let i = 1; i <= 5; i++) {
      bump({ ...info, status: 'running', lastActivityAt: 200 + i * 10 });
      client.markThreadViewed(info.threadId);
    }
    // The bumps from `bump()` are the 5 activity-driven ones — no extras
    // from markThreadViewed under `running`.
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

    // A peer in another process owns these bytes; one malformed frame must
    // not take the channel — or the transcript already on screen — with it.
    expect(() => client.receiveServerFrame('{ not json')).not.toThrow();
    expect(client.getThread('raw-1')?.info.title).toBe('Raw');
  });
});

/**
 * The fold reads the producer's identity off the subscribed thread, so a
 * classification that works in a unit fold still shows nothing on screen if
 * the client never hands that identity over. These drive the socket boundary
 * — raw JSON into `receiveServerFrame`, exactly as `onmessage` delivers it —
 * and read the model the view would render.
 */
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
    // A thread whose in-memory window has trimmed past the durable log's reach
    // replays from the trim point, so the first batch a client sees can open
    // above seq 0. Position in the store's array is what the fold reads the
    // seq off, so a batch that lands without its predecessors must not shift
    // every later event below its true seq — the announcer compares that
    // number against the replay bound, and understating it is silent.
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
    // The invariant the fold reads seqs off, stated directly.
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
