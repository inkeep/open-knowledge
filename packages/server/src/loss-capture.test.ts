import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOSS_CAPTURE_SCHEMA_VERSION,
  LOSS_EVENT_BACKSTOP_TRIP,
  LOSS_EVENT_CHECKPOINT_WRITE,
  LOSS_EVENT_DETECTOR_TRIP,
  LOSS_EVENT_GUARD_DEFER,
  LOSS_EVENT_KINDS,
  LOSS_EVENT_PERSISTENCE_HOLD,
  LOSS_EVENT_REPAIR_REBUILD,
  type LossCaptureEvent,
  LossCaptureEventSchema,
  LossCaptureRing,
  lossCaptureCurrentPath,
  lossCapturePreviousPath,
  parseLossCaptureLines,
} from './loss-capture.ts';

// The real RotatingAppender writes to disk with raw fs; every test gets its own
// tmpdir so runs are hermetic and parallel-safe. No mocks — the ring is
// exercised against the production appender exactly as it runs in the server.
let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'ok-loss-capture-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

/** Read + parse whichever generation files exist, oldest generation first. */
function readAllRetained(): LossCaptureEvent[] {
  const prevPath = lossCapturePreviousPath(projectDir);
  const currentPath = lossCaptureCurrentPath(projectDir);
  const events: LossCaptureEvent[] = [];
  if (existsSync(prevPath)) {
    events.push(...parseLossCaptureLines(readFileSync(prevPath, 'utf-8')));
  }
  if (existsSync(currentPath)) {
    events.push(...parseLossCaptureLines(readFileSync(currentPath, 'utf-8')));
  }
  return events;
}

describe('LossCaptureRing.record', () => {
  it('writes a content-free event line under .ok/local/loss-capture/', async () => {
    const ring = new LossCaptureRing({ projectDir, maxBytes: 1_000_000, now: () => 4242 });
    await ring.record({
      event: LOSS_EVENT_GUARD_DEFER,
      docName: 'notes/plan',
      writerId: null,
      site: 'site-2',
      lostLen: 12,
      digest: 'deadbeef',
    });
    await ring.drain();

    const currentPath = lossCaptureCurrentPath(projectDir);
    expect(currentPath.endsWith(join('.ok', 'local', 'loss-capture', 'loss-current.jsonl'))).toBe(
      true,
    );
    expect(existsSync(currentPath)).toBe(true);

    const events = parseLossCaptureLines(readFileSync(currentPath, 'utf-8'));
    expect(events).toEqual([
      {
        ts: 4242,
        schemaVersion: LOSS_CAPTURE_SCHEMA_VERSION,
        seq: 1,
        event: LOSS_EVENT_GUARD_DEFER,
        docName: 'notes/plan',
        writerId: null,
        site: 'site-2',
        lostLen: 12,
        digest: 'deadbeef',
      },
    ]);
  });

  it('produces one distinguishable kind per loss-class mechanism', async () => {
    // The kinds must never alias — a bundle reader distinguishes a deferred
    // re-derive from a tripped detector/backstop from a written checkpoint from
    // a tolerated persistence hold from an executed destructive rebuild by this
    // field alone.
    expect(new Set(LOSS_EVENT_KINDS).size).toBe(6);

    const ring = new LossCaptureRing({ projectDir, maxBytes: 1_000_000, now: () => 1 });
    for (const kind of LOSS_EVENT_KINDS) {
      await ring.record({ event: kind, docName: 'd', writerId: null });
    }
    await ring.drain();

    const kinds = readAllRetained().map((e) => e.event);
    expect(kinds).toEqual([
      LOSS_EVENT_GUARD_DEFER,
      LOSS_EVENT_DETECTOR_TRIP,
      LOSS_EVENT_BACKSTOP_TRIP,
      LOSS_EVENT_CHECKPOINT_WRITE,
      LOSS_EVENT_PERSISTENCE_HOLD,
      LOSS_EVENT_REPAIR_REBUILD,
    ]);
    expect(new Set(kinds).size).toBe(6);
  });

  it('keeps the newest events when the file rotates at its cap', async () => {
    // A small cap forces several rotations. The two-generation ring drops the
    // OLDEST events; the newest must always survive.
    const ring = new LossCaptureRing({ projectDir, maxBytes: 400, now: () => 7 });
    const total = 24;
    for (let i = 0; i < total; i++) {
      await ring.record({ event: LOSS_EVENT_GUARD_DEFER, docName: 'doc', writerId: null });
    }
    await ring.drain();

    // Rotation actually happened (a previous generation exists).
    expect(existsSync(lossCapturePreviousPath(projectDir))).toBe(true);

    const retained = readAllRetained();
    const seqs = retained.map((e) => e.seq);
    // Newest event is present; oldest were dropped (footprint bounded).
    expect(Math.max(...seqs)).toBe(total);
    expect(retained.length).toBeLessThan(total);
    expect(retained.length).toBeGreaterThan(0);
  });

  it('keeps per-doc counters monotonic across rotation, independent per doc', async () => {
    const ring = new LossCaptureRing({ projectDir, maxBytes: 400, now: () => 9 });
    const perDoc = 20;
    for (let i = 0; i < perDoc; i++) {
      await ring.record({ event: LOSS_EVENT_DETECTOR_TRIP, docName: 'alpha', writerId: null });
      await ring.record({ event: LOSS_EVENT_DETECTOR_TRIP, docName: 'beta', writerId: null });
    }
    await ring.drain();
    expect(existsSync(lossCapturePreviousPath(projectDir))).toBe(true);

    const retained = readAllRetained();
    for (const docName of ['alpha', 'beta']) {
      const seqs = retained.filter((e) => e.docName === docName).map((e) => e.seq);
      expect(seqs.length).toBeGreaterThan(0);
      // Strictly increasing across the retained window: a reset (restart at 1)
      // after rotation would show a decrease, so this pins "no reset".
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThan(seqs[i - 1] as number);
      }
      // The counter counted every event for this doc — it never reset to the
      // file's contents, so its max equals the number recorded.
      expect(Math.max(...seqs)).toBe(perDoc);
    }
  });
});

describe('LossCaptureEventSchema (content-free BY SCHEMA)', () => {
  it('declares exactly the shape+correlation fields — no content field can exist', () => {
    const keys = Object.keys(LossCaptureEventSchema.shape).sort();
    expect(keys).toEqual([
      'checkpointSha',
      'connections',
      'digest',
      'direction',
      'docName',
      'event',
      'lostLen',
      'schemaVersion',
      'seq',
      'site',
      'ts',
      'which',
      'witnessAvailable',
      'writerId',
    ]);
    // Belt-and-suspenders: none of the fields is a content-bearing name. The
    // exact key set above is the real guard (adding any field fails this test);
    // this names the class the schema must never carry.
    const contentShaped = [
      'content',
      'body',
      'text',
      'preview',
      'snippet',
      'payload',
      'lostContent',
      'value',
      'raw',
      'bytes',
    ];
    expect(keys.filter((k) => contentShaped.includes(k))).toEqual([]);
  });

  it('round-trips serialize -> parse -> deep-equal', () => {
    const event: LossCaptureEvent = {
      ts: 1234,
      schemaVersion: LOSS_CAPTURE_SCHEMA_VERSION,
      seq: 3,
      event: LOSS_EVENT_CHECKPOINT_WRITE,
      docName: 'projects/roadmap',
      writerId: 'agent-7',
      direction: 'B',
      lostLen: 88,
      digest: 'abc123',
      checkpointSha: 'f00dcafe',
      which: 'growth',
      witnessAvailable: false,
      connections: 2,
    };
    const roundTripped = LossCaptureEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(roundTripped).toEqual(event);
  });

  it('tolerates a newer-schema row with an unknown kind (forward-compat)', () => {
    // A reader on schema version N must not choke on a row a future version
    // wrote: an unrecognized `event` kind is preserved, and an unknown extra
    // field is dropped rather than rejected.
    const futureRow = JSON.stringify({
      ts: 500,
      schemaVersion: LOSS_CAPTURE_SCHEMA_VERSION + 1,
      seq: 1,
      event: 'some-future-kind',
      docName: 'd',
      writerId: null,
      someFutureField: { nested: true },
    });
    const events = parseLossCaptureLines(futureRow);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('some-future-kind');
    expect(events[0]?.schemaVersion).toBe(LOSS_CAPTURE_SCHEMA_VERSION + 1);
    expect(events[0]).not.toHaveProperty('someFutureField');
  });

  it('skips a malformed trailing line (SIGKILL-partial tolerance)', () => {
    const good = JSON.stringify({
      ts: 1,
      schemaVersion: LOSS_CAPTURE_SCHEMA_VERSION,
      seq: 1,
      event: LOSS_EVENT_GUARD_DEFER,
      docName: 'd',
      writerId: null,
    });
    const events = parseLossCaptureLines(`${good}\n{"ts":2,"schemaVersio`);
    expect(events).toHaveLength(1);
    expect(events[0]?.seq).toBe(1);
  });
});
