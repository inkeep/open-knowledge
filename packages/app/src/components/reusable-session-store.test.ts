/**
 * The appendable-session signal.
 *
 * It exists so a send button can name its destination BEFORE the click, which
 * makes one property load-bearing above all others: it must never hold a
 * session the dock would refuse to reuse. `null` is the safe answer — a send
 * then starts a fresh turn, which is always possible. A false positive is a
 * button promising an append that silently becomes something else.
 */

import { afterEach, describe, expect, test } from 'vitest';
import {
  _resetReusableSession,
  getReusableSession,
  publishReusableSession,
  subscribeReusableSession,
} from './reusable-session-store';

afterEach(() => _resetReusableSession());

describe('the reusable-session store', () => {
  test('starts empty, so a send starts a turn until told otherwise', () => {
    expect(getReusableSession()).toBeNull();
  });

  test('publishes what the destination needs to be drawn, not just named', () => {
    // The consumer renders a brand mark from these; with only a name it would
    // fall back to whatever icon it could reach — the Claude mark on a Cursor
    // tab, which is the bug this shape exists to prevent.
    publishReusableSession('agents', {
      id: 'thread-1',
      kind: 'thread',
      label: 'Claude Agent',
      agentId: 'claude',
      iconUrl: 'https://example.test/claude.svg',
    });
    expect(getReusableSession()).toEqual({
      id: 'thread-1',
      kind: 'thread',
      label: 'Claude Agent',
      agentId: 'claude',
      iconUrl: 'https://example.test/claude.svg',
    });
  });

  test('notifies subscribers on a real change', () => {
    let notified = 0;
    subscribeReusableSession(() => {
      notified += 1;
    });

    publishReusableSession('agents', {
      id: 'thread-1',
      kind: 'thread',
      label: 'Claude Agent',
      agentId: 'claude',
    });
    expect(notified).toBe(1);

    // Cleared on the SAME surface that set it. Clearing the other dock's slot
    // would leave this thread standing, which is the whole point of the split:
    // an empty terminal no longer erases a live conversation.
    publishReusableSession('agents', null);
    expect(notified).toBe(2);
    expect(getReusableSession()).toBeNull();
  });

  test("an empty dock does not erase the other dock's session", () => {
    // BOTH docks mount at once and both publish on every change. With one slot
    // the last writer won: the terminal dock publishing null for its empty tab
    // list wiped a live agent thread, and every send button outside the docks
    // then read "nothing to reuse" with a conversation open on screen.
    publishReusableSession('agents', {
      id: 'thread-1',
      kind: 'thread',
      label: 'Claude Agent',
      agentId: 'claude',
    });
    publishReusableSession('terminal', null);

    expect(getReusableSession()).toMatchObject({ id: 'thread-1', kind: 'thread' });
  });

  test('a thread outranks a terminal when both docks hold one', () => {
    publishReusableSession('terminal', {
      id: 'terminal-session-1',
      kind: 'terminal',
      label: 'Claude',
      cli: 'claude',
    });
    publishReusableSession('agents', {
      id: 'thread-1',
      kind: 'thread',
      label: 'Claude Agent',
      agentId: 'claude',
    });

    // The comment surfaces send to threads alone, so the answer they read has
    // to be the one they can act on.
    expect(getReusableSession()).toMatchObject({ kind: 'thread' });
  });

  test('a value-equal publish is a no-op', () => {
    // The host re-publishes freely rather than tracking what changed, so the
    // store absorbs the churn — otherwise `useSyncExternalStore` would see a
    // new snapshot on every PTY callback and re-render the send button.
    let notified = 0;
    publishReusableSession('terminal', {
      id: 'terminal-session-1',
      kind: 'terminal',
      label: 'Claude',
      cli: 'claude',
    });
    subscribeReusableSession(() => {
      notified += 1;
    });

    publishReusableSession('terminal', {
      id: 'terminal-session-1',
      kind: 'terminal',
      label: 'Claude',
      cli: 'claude',
    });
    expect(notified).toBe(0);
  });

  test('a swapped icon source reaches subscribers even when the id holds', () => {
    // Same tab id, different CLI: if the equality check ignored the icon input
    // the button would keep drawing the old brand mark.
    let notified = 0;
    publishReusableSession('terminal', {
      id: 's1',
      kind: 'terminal',
      label: 'Claude',
      cli: 'claude',
    });
    subscribeReusableSession(() => {
      notified += 1;
    });

    publishReusableSession('terminal', {
      id: 's1',
      kind: 'terminal',
      label: 'Codex',
      cli: 'codex',
    });
    expect(notified).toBe(1);
    expect(getReusableSession()).toMatchObject({ cli: 'codex', label: 'Codex' });
  });

  test('a thread and a terminal sharing an id are not the same session', () => {
    let notified = 0;
    publishReusableSession('terminal', {
      id: 's1',
      kind: 'terminal',
      label: 'Claude',
      cli: 'claude',
    });
    subscribeReusableSession(() => {
      notified += 1;
    });

    publishReusableSession('agents', {
      id: 's1',
      kind: 'thread',
      label: 'Claude',
      agentId: 'claude',
    });
    expect(notified).toBe(1);
    expect(getReusableSession()?.kind).toBe('thread');
  });

  test('unsubscribing stops delivery', () => {
    let notified = 0;
    const unsubscribe = subscribeReusableSession(() => {
      notified += 1;
    });
    unsubscribe();

    publishReusableSession('agents', {
      id: 's1',
      kind: 'thread',
      label: 'Claude Agent',
      agentId: 'claude',
    });
    expect(notified).toBe(0);
  });
});
