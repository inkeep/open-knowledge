import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { installSignalBoundary } from '../../test-support/held-signal-boundary.test-helper.ts';
import { createOwnedTreeController, runWithRetry } from './retry-transient.mjs';

const ATTEMPT_TIMEOUT_MS = 3_000;
const DESCENDANT_LIFETIME_S = 8;
const CLOSE_LIVENESS_BOUND_MS = 30_000;

let boundary;
const children = [];

afterEach(async () => {
  boundary?.restore();
  boundary = undefined;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
  }
  children.length = 0;
});

describe.skipIf(process.platform === 'win32')('runWithRetry owned-tree cleanup', () => {
  test('an attempt whose shell exited while a descendant still holds its output sends nothing to the reaped shell group and reports the failed cleanup', async () => {
    boundary = installSignalBoundary({ deliverToHeldChildren: true });
    const held = boundary;
    const closes = [];
    const spawnFn = (...args) => {
      const child = held.hold(spawn(...args));
      children.push(child);
      closes.push(once(child, 'close'));
      return child;
    };
    expect(process.kill).toBe(held.send);

    const result = await runWithRetry({
      command: [`sleep ${DESCENDANT_LIFETIME_S} & exit 0`],
      shell: true,
      maxAttempts: 1,
      attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
      cleanupGraceMs: 200,
      cleanupReserveMs: 400,
      spawnFn,
      log: () => {},
      signalSource: new EventEmitter(),
    });
    const [leader] = children;
    await Promise.race([
      Promise.all(closes),
      new Promise((resolve) => setTimeout(resolve, CLOSE_LIVENESS_BOUND_MS)),
    ]);

    expect({
      leaderExitedOnItsOwn: leader?.exitCode === 0 && leader?.signalCode === null,
      refused: held.refused,
      reportedFailure: result.ok === false,
    }).toEqual({ leaderExitedOnItsOwn: true, refused: [], reportedFailure: true });
  }, 60_000);
});

describe('createOwnedTreeController signals only while the attempt leader is unreaped', () => {
  const LEADER_PID = 4321;
  const PROBES_WHILE_MEMBERS_REMAIN = 3;
  const GROUP_DRAIN_LIVENESS_BOUND_MS = 5_000;
  const closeNeverObserved = { graceMs: 1, cleanupReserveMs: 1, waitForClose: async () => false };
  const closeObserved = { graceMs: 1, cleanupReserveMs: 1, waitForClose: async () => true };
  let backstop;

  beforeEach(() => {
    backstop = installSignalBoundary({ deliverToHeldChildren: false });
  });

  afterEach(() => {
    backstop.restore();
  });

  const attemptLeader = (state = {}) => ({
    pid: LEADER_PID,
    exitCode: null,
    signalCode: null,
    ...state,
  });

  const posixController = (onSend = () => {}) => {
    const sends = [];
    const controller = createOwnedTreeController({
      platform: 'linux',
      killFn: (target, signal) => {
        if (signal === 0) return;
        sends.push([target, signal]);
        onSend(signal);
      },
      sleepFn: async () => {},
      pollIntervalMs: 1,
    });
    return { controller, sends };
  };

  const drainingGroupController = () => {
    const sends = [];
    const probedTargets = [];
    const controller = createOwnedTreeController({
      platform: 'linux',
      killFn: (target, signal) => {
        if (signal !== 0) {
          sends.push([target, signal]);
          return;
        }
        probedTargets.push(target);
        if (probedTargets.length > PROBES_WHILE_MEMBERS_REMAIN) {
          throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
        }
      },
      sleepFn: async () => {},
      pollIntervalMs: 1,
    });
    return { controller, sends, probedTargets };
  };

  const win32Controller = (onTaskkill = () => {}) => {
    const taskkills = [];
    const controller = createOwnedTreeController({
      platform: 'win32',
      taskkillFn: async (args) => {
        taskkills.push(args);
        onTaskkill();
        return { ok: true };
      },
    });
    return { controller, taskkills };
  };

  test("an exited leader whose group still has members draws no signal, and a close that never comes is reported as 'tree-outlived-leader'", async () => {
    const { controller, sends } = posixController();

    const result = await controller.cleanup(attemptLeader({ exitCode: 0 }), closeNeverObserved);

    expect({ result, sends, reachedProcessKill: backstop.refused }).toEqual({
      result: { ok: false, reason: 'tree-outlived-leader' },
      sends: [],
      reachedProcessKill: [],
    });
  });

  test("an exited leader whose output closed while its group still has members draws no signal, and is reported as 'tree-outlived-leader'", async () => {
    const { controller, sends } = posixController();

    const result = await controller.cleanup(
      attemptLeader({ signalCode: 'SIGTERM' }),
      closeObserved,
    );

    expect({ result, sends, reachedProcessKill: backstop.refused }).toEqual({
      result: { ok: false, reason: 'tree-outlived-leader' },
      sends: [],
      reachedProcessKill: [],
    });
  });

  test("a held leader's group gets SIGTERM, and once that SIGTERM reaped the leader a group that persists gets no SIGKILL and is reported as 'tree-outlived-leader'", async () => {
    const leader = attemptLeader();
    const { controller, sends } = posixController((signal) => {
      if (signal === 'SIGTERM') leader.signalCode = 'SIGTERM';
    });

    const result = await controller.cleanup(leader, closeNeverObserved);

    expect({ result, sends, reachedProcessKill: backstop.refused }).toEqual({
      result: { ok: false, reason: 'tree-outlived-leader' },
      sends: [[-LEADER_PID, 'SIGTERM']],
      reachedProcessKill: [],
    });
  });

  test.each([
    { close: 'observed', waitForClose: async () => true, ok: true, reason: 'clean' },
    {
      close: 'never observed',
      waitForClose: async () => false,
      ok: false,
      reason: 'close-not-observed',
    },
  ])(
    'an exited leader whose group drains on its own inside the grace window draws no signal, and a close that is $close settles it as $reason',
    async ({ waitForClose, ok, reason }) => {
      const { controller, sends, probedTargets } = drainingGroupController();

      const result = await controller.cleanup(attemptLeader({ exitCode: 0 }), {
        graceMs: GROUP_DRAIN_LIVENESS_BOUND_MS,
        cleanupReserveMs: 1,
        waitForClose,
      });

      expect({
        result,
        sends,
        probedTheLeaderGroupUntilItDrained:
          probedTargets.length > PROBES_WHILE_MEMBERS_REMAIN &&
          probedTargets.every((target) => target === -LEADER_PID),
        reachedProcessKill: backstop.refused,
      }).toEqual({
        result: { ok, reason },
        sends: [],
        probedTheLeaderGroupUntilItDrained: true,
        reachedProcessKill: [],
      });
    },
  );

  test("on win32 an exited leader gets no taskkill, and a close that never comes is reported as 'tree-outlived-leader'", async () => {
    const { controller, taskkills } = win32Controller();

    const result = await controller.cleanup(attemptLeader({ exitCode: 1 }), closeNeverObserved);

    expect({ result, taskkills, reachedProcessKill: backstop.refused }).toEqual({
      result: { ok: false, reason: 'tree-outlived-leader' },
      taskkills: [],
      reachedProcessKill: [],
    });
  });

  test('on win32 a held leader is tree-killed by its own pid, and the forced taskkill is skipped once the graceful one reaped the leader', async () => {
    const leader = attemptLeader();
    const { controller, taskkills } = win32Controller(() => {
      leader.exitCode = 1;
    });

    const result = await controller.cleanup(leader, closeNeverObserved);

    expect({ result, taskkills, reachedProcessKill: backstop.refused }).toEqual({
      result: { ok: false, reason: 'tree-outlived-leader' },
      taskkills: [['/PID', String(LEADER_PID), '/T']],
      reachedProcessKill: [],
    });
  });
});
