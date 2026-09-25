import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { installSignalBoundary } from '../test-support/held-signal-boundary.test-helper.ts';

const [runner = {}] = Object.values(
  import.meta.glob('./run-in-own-process-group.mjs', { eager: true }),
);
const { relayToHeldGroup } = runner;

const CHILD_PID = 424_242;

let backstop;

beforeEach(() => {
  backstop = installSignalBoundary({ deliverToHeldChildren: false });
});

afterEach(() => {
  backstop.restore();
});

function recordingSend() {
  const sent = [];
  return {
    sent,
    send: (target, signal) => {
      sent.push([target, signal]);
      return true;
    },
  };
}

describe('relayToHeldGroup relays a signal only while the child it spawned is unreaped', () => {
  test.each([
    ['exits with a code', { exitCode: 0, signalCode: null }],
    ['is killed by a signal', { exitCode: null, signalCode: 'SIGKILL' }],
  ])(
    'relays to the group of a running child, and sends nothing once the child %s',
    (_label, exit) => {
      expect(typeof relayToHeldGroup).toBe('function');
      const { sent, send } = recordingSend();
      const child = { pid: CHILD_PID, exitCode: null, signalCode: null };

      relayToHeldGroup(child, 'SIGTERM', send);
      Object.assign(child, exit);
      relayToHeldGroup(child, 'SIGINT', send);

      expect({ sent, reachedProcessKill: backstop.refused }).toEqual({
        sent: [[-CHILD_PID, 'SIGTERM']],
        reachedProcessKill: [],
      });
    },
  );

  test('sends nothing for a child that never received a pid', () => {
    expect(typeof relayToHeldGroup).toBe('function');
    const { sent, send } = recordingSend();

    relayToHeldGroup({ pid: undefined, exitCode: null, signalCode: null }, 'SIGHUP', send);
    relayToHeldGroup({ pid: CHILD_PID, exitCode: null, signalCode: null }, 'SIGHUP', send);

    expect({ sent, reachedProcessKill: backstop.refused }).toEqual({
      sent: [[-CHILD_PID, 'SIGHUP']],
      reachedProcessKill: [],
    });
  });
});

function relayRefusedWith(code) {
  const sent = [];
  const send = (target, signal) => {
    sent.push([target, signal]);
    throw Object.assign(new Error(`kill ${code}`), { code });
  };
  const written = [];
  const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  try {
    relayToHeldGroup({ pid: CHILD_PID, exitCode: null, signalCode: null }, 'SIGTERM', send);
    return { escaped: null, sent, stderr: written.join('') };
  } catch (error) {
    return { escaped: error.code, sent, stderr: written.join('') };
  } finally {
    write.mockRestore();
  }
}

describe('relayToHeldGroup keeps a send refused because the group is already gone inside the relay', () => {
  test.each([
    ['ESRCH', false],
    ['EPERM', true],
  ])(
    'a send refused with %s does not escape the relay (reported on stderr: %s)',
    (code, reported) => {
      expect(typeof relayToHeldGroup).toBe('function');

      const outcome = relayRefusedWith(code);

      expect({
        escaped: outcome.escaped,
        sent: outcome.sent,
        stderr: outcome.stderr,
        reachedProcessKill: backstop.refused,
      }).toEqual({
        escaped: null,
        sent: [[-CHILD_PID, 'SIGTERM']],
        stderr: reported ? expect.stringContaining(code) : '',
        reachedProcessKill: [],
      });
    },
  );

  test('a send refused for any other reason still escapes the relay', () => {
    expect(typeof relayToHeldGroup).toBe('function');

    const outcome = relayRefusedWith('EINVAL');

    expect({
      escaped: outcome.escaped,
      sent: outcome.sent,
      stderr: outcome.stderr,
      reachedProcessKill: backstop.refused,
    }).toEqual({
      escaped: 'EINVAL',
      sent: [[-CHILD_PID, 'SIGTERM']],
      stderr: '',
      reachedProcessKill: [],
    });
  });
});
