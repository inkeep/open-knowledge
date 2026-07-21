import { readFileSync } from 'node:fs';
import type {
  ThreadEvent,
  ThreadInfo,
  ThreadServerFrame,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { describe, expect, test } from 'vitest';
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
