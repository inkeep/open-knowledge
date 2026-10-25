import type {
  ThreadClientFrame,
  ThreadServerFrame,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { describe, expect, test } from 'vitest';
import { closeThreadAndDelete } from '../stress/hidden-chat-transport.test-helper';

const noPause = async () => {};

type SocketLogEntry = { kind: 'sent'; frame: ThreadClientFrame } | { kind: 'pause' };

interface WaitCall {
  deadline: number | undefined;
  afterDelete: boolean;
}

function replyingThreadSocket(rosterReplies: ThreadServerFrame[]) {
  const replies = [...rosterReplies];
  const frames: ThreadServerFrame[] = [];
  const log: SocketLogEntry[] = [];
  const sentDuringMatches: ThreadClientFrame[] = [];
  const sentWhilePauseHeld: ThreadClientFrame[] = [];
  const waitCalls: WaitCall[] = [];
  const unclaimedPauseReleases: Array<() => void> = [];
  const pauseClaimers: Array<(release: () => void) => void> = [];
  let matchesCalls = 0;
  let insideMatches = false;
  let heldPauses = 0;

  const send = (frame: ThreadClientFrame) => {
    log.push({ kind: 'sent', frame });
    if (insideMatches) sentDuringMatches.push(frame);
    if (heldPauses > 0) sentWhilePauseHeld.push(frame);
    const reply = replies.shift();
    if (reply !== undefined) frames.push(reply);
  };
  const waitForFrame = async (
    matches: (frame: ThreadServerFrame) => boolean,
    fromIndex: number,
    deadline?: number,
  ) => {
    waitCalls.push({
      deadline,
      afterDelete: log.some((entry) => entry.kind === 'sent' && entry.frame.op === 'delete'),
    });
    for (let index = fromIndex; index < frames.length; index++) {
      const frame = frames[index];
      matchesCalls += 1;
      insideMatches = true;
      const matched = matches(frame);
      insideMatches = false;
      if (matched) return frame;
    }
    throw new Error('roster replies ended before the expected frame');
  };
  const pauseBeforeRefresh = () => {
    log.push({ kind: 'pause' });
    heldPauses += 1;
    return new Promise<void>((resolve) => {
      const release = () => {
        heldPauses -= 1;
        resolve();
      };
      const claimer = pauseClaimers.shift();
      if (claimer === undefined) unclaimedPauseReleases.push(release);
      else claimer(release);
    });
  };
  const nextHeldPause = () =>
    new Promise<() => void>((resolve) => {
      const release = unclaimedPauseReleases.shift();
      if (release === undefined) pauseClaimers.push(resolve);
      else resolve(release);
    });

  return {
    log,
    sentDuringMatches,
    sentWhilePauseHeld,
    waitCalls,
    matchesCallCount: () => matchesCalls,
    send,
    waitForFrame,
    frameIndex: () => frames.length,
    pauseBeforeRefresh,
    nextHeldPause,
  };
}

function rosterRepliesForConcurrentClose(threadId: string): ThreadServerFrame[] {
  return [
    { op: 'threads', threads: [{ threadId, archived: false }] },
    { op: 'threads', threads: [{ threadId, archived: false }] },
    { op: 'threads', threads: [{ threadId, archived: true }] },
    { op: 'threads', threads: [] },
  ];
}

describe('closeThreadAndDelete', () => {
  test('waits for the archived roster before deleting a closed thread', async () => {
    const threadId = 'thread-under-test';
    const frames: ThreadServerFrame[] = [
      { op: 'threads', threads: [{ threadId, archived: false }] },
      { op: 'threads', threads: [{ threadId, archived: true }] },
      { op: 'threads', threads: [] },
    ];
    const sent: ThreadClientFrame[] = [];
    let nextFrame = 0;

    await closeThreadAndDelete(
      threadId,
      (frame) => sent.push(frame),
      async (matches) => {
        while (nextFrame < frames.length) {
          const frame = frames[nextFrame++];
          if (matches(frame)) return frame;
        }
        throw new Error('frame stream ended before the expected frame');
      },
      () => nextFrame,
      noPause,
    );

    expect(sent).toEqual([{ op: 'close', threadId }, { op: 'list' }, { op: 'delete', threadId }]);
  });

  test('does not delete a thread that close already discarded', async () => {
    const threadId = 'empty-thread';
    const sent: ThreadClientFrame[] = [];
    let nextFrame = 0;

    await closeThreadAndDelete(
      threadId,
      (frame) => sent.push(frame),
      async (matches) => {
        const frame: ThreadServerFrame = { op: 'threads', threads: [] };
        nextFrame += 1;
        if (matches(frame)) return frame;
        throw new Error(`frame ${nextFrame} did not satisfy the close predicate`);
      },
      () => nextFrame,
      noPause,
    );

    expect(sent).toEqual([{ op: 'close', threadId }]);
  });

  test('pauses before every roster refresh while a concurrent close is still archiving', async () => {
    const threadId = 'concurrently-closing-thread';
    const socket = replyingThreadSocket(rosterRepliesForConcurrentClose(threadId));

    const closed = closeThreadAndDelete(
      threadId,
      socket.send,
      socket.waitForFrame,
      socket.frameIndex,
      socket.pauseBeforeRefresh,
    ).then(() => ({ kind: 'closed' }) as const);
    for (;;) {
      const step = await Promise.race([
        closed,
        socket.nextHeldPause().then((release) => ({ kind: 'paused', release }) as const),
      ]);
      if (step.kind === 'closed') break;
      step.release();
    }

    expect(socket.sentWhilePauseHeld, 'frames sent before the pause ahead of them settled').toEqual(
      [],
    );
    expect(socket.log).toEqual([
      { kind: 'sent', frame: { op: 'close', threadId } },
      { kind: 'pause' },
      { kind: 'sent', frame: { op: 'list' } },
      { kind: 'pause' },
      { kind: 'sent', frame: { op: 'list' } },
      { kind: 'sent', frame: { op: 'delete', threadId } },
    ]);
  });

  test('sends roster refreshes from the helper rather than from the frame matcher', async () => {
    const threadId = 'concurrently-closing-thread';
    const socket = replyingThreadSocket(rosterRepliesForConcurrentClose(threadId));

    await closeThreadAndDelete(
      threadId,
      socket.send,
      socket.waitForFrame,
      socket.frameIndex,
      noPause,
    );

    expect(socket.matchesCallCount()).toBeGreaterThan(0);
    expect(socket.log).toContainEqual({ kind: 'sent', frame: { op: 'list' } });
    expect(socket.sentDuringMatches, 'frames sent while the matcher ran').toEqual([]);
  });

  test('gives every close-phase roster wait the same finite deadline', async () => {
    const threadId = 'concurrently-closing-thread';
    const socket = replyingThreadSocket(rosterRepliesForConcurrentClose(threadId));

    await closeThreadAndDelete(
      threadId,
      socket.send,
      socket.waitForFrame,
      socket.frameIndex,
      noPause,
    );

    const closePhaseDeadlines = socket.waitCalls
      .filter((call) => !call.afterDelete)
      .map((call) => call.deadline);
    expect(
      Number.isFinite(closePhaseDeadlines[0]),
      'the close phase waits under a finite deadline the helper supplies',
    ).toBe(true);
    expect(closePhaseDeadlines.length).toBeGreaterThanOrEqual(2);
    expect(closePhaseDeadlines).toEqual(closePhaseDeadlines.map(() => closePhaseDeadlines[0]));
  });
});
