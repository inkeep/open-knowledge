import { afterEach, describe, expect, test } from 'bun:test';
import {
  _clearTerminalSessionRegistry,
  findIdleMatchingSession,
  IDLE_QUIET_MS,
  registerTerminalSession,
  unregisterTerminalSession,
  updateTerminalSession,
} from './terminal-session-registry';

afterEach(() => {
  _clearTerminalSessionRegistry();
});

function register(
  id: string,
  cli: 'claude' | 'codex' | 'cursor' | null,
  ptyId: string | null,
  lastOutputAt: number,
  hasOutput: boolean,
) {
  registerTerminalSession({ id, cli, ptyId, lastOutputAt, hasOutput });
}

describe('findIdleMatchingSession', () => {
  const now = 100_000;

  test('returns null when there is no matching session', () => {
    register('a', 'codex', 'pty-a', now - IDLE_QUIET_MS - 1, true);
    expect(findIdleMatchingSession('cursor', now)).toBeNull();
  });

  test('matches a same-CLI session that is idle (quiet long enough)', () => {
    register('a', 'claude', 'pty-a', now - IDLE_QUIET_MS - 1, true);
    expect(findIdleMatchingSession('claude', now)?.id).toBe('a');
  });

  test('does NOT match a busy (recently-active) session', () => {
    register('a', 'claude', 'pty-a', now - 10, true); // 10ms ago → busy
    expect(findIdleMatchingSession('claude', now)).toBeNull();
  });

  test('does NOT match a session whose prompt has not produced output yet', () => {
    register('a', 'claude', 'pty-a', 0, false);
    expect(findIdleMatchingSession('claude', now)).toBeNull();
  });

  test('does NOT match a session with a dead (null) PTY', () => {
    register('a', 'claude', null, now - IDLE_QUIET_MS - 1, true);
    expect(findIdleMatchingSession('claude', now)).toBeNull();
  });

  test('a bare shell (cli null) never matches a CLI launch', () => {
    register('a', null, 'pty-a', now - IDLE_QUIET_MS - 1, true);
    expect(findIdleMatchingSession('claude', now)).toBeNull();
  });

  test('picks the most-recently-active qualifying session', () => {
    register('older', 'codex', 'pty-1', now - IDLE_QUIET_MS - 100, true);
    register('newer', 'codex', 'pty-2', now - IDLE_QUIET_MS - 5, true);
    expect(findIdleMatchingSession('codex', now)?.id).toBe('newer');
  });
});

describe('registry mutation', () => {
  const now = 100_000;

  test('updateTerminalSession patches activity so a busy session becomes idle after the quiet window', () => {
    register('a', 'claude', 'pty-a', now, true); // just streamed → busy
    expect(findIdleMatchingSession('claude', now)).toBeNull();
    // Time passes, no new output → the same last-output stamp is now old enough.
    expect(findIdleMatchingSession('claude', now + IDLE_QUIET_MS + 1)?.id).toBe('a');
  });

  test('updateTerminalSession on an unregistered id is a no-op (no throw)', () => {
    expect(() => updateTerminalSession('missing', { ptyId: 'x' })).not.toThrow();
    expect(findIdleMatchingSession('claude', now)).toBeNull();
  });

  test('unregister drops the session from match results', () => {
    register('a', 'claude', 'pty-a', now - IDLE_QUIET_MS - 1, true);
    expect(findIdleMatchingSession('claude', now)?.id).toBe('a');
    unregisterTerminalSession('a');
    expect(findIdleMatchingSession('claude', now)).toBeNull();
  });

  test('clearing a PTY id (exit) makes a previously-idle session uninjectable', () => {
    register('a', 'claude', 'pty-a', now - IDLE_QUIET_MS - 1, true);
    updateTerminalSession('a', { ptyId: null });
    expect(findIdleMatchingSession('claude', now)).toBeNull();
  });
});
