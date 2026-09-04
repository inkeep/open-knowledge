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

    publishReusableSession('agents', null);
    expect(notified).toBe(2);
    expect(getReusableSession()).toBeNull();
  });

  test("an empty dock does not erase the other dock's session", () => {
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

    expect(getReusableSession()).toMatchObject({ kind: 'thread' });
  });

  test('a value-equal publish is a no-op', () => {
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
