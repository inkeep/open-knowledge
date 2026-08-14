/**
 * Content-free local ring for bridge loss-class events.
 *
 * Every event that a loss-class mechanism produces — a deferred re-derive, a
 * tripped post-condition detector, a tripped re-derive backstop, a written
 * recovery checkpoint — lands here as one line of JSON under
 * `<projectDir>/.ok/local/loss-capture/loss-current.jsonl`. The ring rides the
 * shared two-generation `RotatingAppender` at its own cap so it never competes
 * with the larger telemetry span / server-log rings; `ok diagnose bundle`
 * stages it at the Detailed-diagnostics tier so a bug bundle carries loss
 * signal without a live repro.
 *
 * The event carries shape + correlation only: a byte length and a
 * caller-supplied digest, never the lost bytes themselves. Content-free is a
 * property of the SCHEMA, not a runtime scrub — `record()` has no channel that
 * accepts document content, so no content can flow in. The producer computes
 * any digest before it reaches the ring.
 */

import { join } from 'node:path';
import type { BridgeMergeContentLossWhich } from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import { getLogger } from './logger.ts';
import { RotatingAppender } from './telemetry-file-sink.ts';

const log = getLogger('loss-capture');

/**
 * Bumped only when the on-disk event shape changes in a way older readers must
 * be told about. Readers tolerate a higher value on a row (see
 * {@link parseLossCaptureLines}) — the field exists so a future migration can
 * branch on it, not so a mismatch is rejected.
 */
export const LOSS_CAPTURE_SCHEMA_VERSION = 1;

// Distinguishable loss-class event kinds — the field-metric vocabulary a bug
// bundle (and opt-in OTel) reports against. Producers emit these constants; the
// read schema keeps `event` open (`z.string()`) so a reader tolerates a row
// whose kind a newer version introduced. Extending the vocabulary is a
// deliberate one-line edit here, never an accident at a call site.
export const LOSS_EVENT_GUARD_DEFER = 'guard-defer';
export const LOSS_EVENT_DETECTOR_TRIP = 'detector-trip';
export const LOSS_EVENT_BACKSTOP_TRIP = 'backstop-trip';
export const LOSS_EVENT_CHECKPOINT_WRITE = 'checkpoint-write';
// Persistence declined to rebuild the fragment because the whole divergence was
// content the derive-timing guard is holding — a HOLD, not a loss. Its own kind
// so a bundle reader can tell "the hygiene layer tolerated a divergence" from
// "a detector tripped", which are opposite outcomes at the same boundary.
export const LOSS_EVENT_PERSISTENCE_HOLD = 'persistence-hold';
// A destructive fragment rebuild actually ran. Distinct from
// `checkpoint-write`, which reports that a restore ANCHOR was minted: the two
// are not 1:1, because the anchor mint is deduped per document against its last
// payload and is skipped entirely when serialization produced no fragment view.
// A document whose fragment view diverges on every write-back therefore rebuilds
// indefinitely while emitting at most one anchor, so without its own kind the
// rebuild RATE — the thing that distinguishes a one-off repair from a document
// stuck in a permanent repair loop — is absent from the ring.
export const LOSS_EVENT_REPAIR_REBUILD = 'repair-rebuild';

export const LOSS_EVENT_KINDS = [
  LOSS_EVENT_GUARD_DEFER,
  LOSS_EVENT_DETECTOR_TRIP,
  LOSS_EVENT_BACKSTOP_TRIP,
  LOSS_EVENT_CHECKPOINT_WRITE,
  LOSS_EVENT_PERSISTENCE_HOLD,
  LOSS_EVENT_REPAIR_REBUILD,
] as const;

type LossEventKind = (typeof LOSS_EVENT_KINDS)[number];

/**
 * The persisted event shape. Every field is shape or correlation — there is no
 * body-text / content field, and `loss-capture.test.ts` asserts the key set
 * exactly so one can never be added without that test failing (content-free BY
 * SCHEMA). `z.object` strips unknown keys on read, which is what makes a row
 * written by a newer schema tolerable to an older reader.
 */
export const LossCaptureEventSchema = z.object({
  /** Event wall-clock time in epoch milliseconds (stamped by the ring). */
  ts: z.number(),
  /** {@link LOSS_CAPTURE_SCHEMA_VERSION} at write time. */
  schemaVersion: z.number(),
  /** Per-doc monotonic sequence, assigned at record time; survives rotation. */
  seq: z.number(),
  /** Loss-class kind. Open string so future kinds parse on an older reader. */
  event: z.string(),
  /** Raw document name (kept raw locally; consent-gated at bundle time). */
  docName: z.string(),
  /** Writer identity when known; null otherwise (a slot future writers fill). */
  writerId: z.string().nullable(),
  /** Re-derive site the event fired at, when applicable. */
  site: z.string().optional(),
  /** Observer direction the event fired on, when applicable. */
  direction: z.string().optional(),
  /** Byte length of the at-risk / lost content — a length, never the bytes. */
  lostLen: z.number().optional(),
  /** Caller-computed digest of the at-risk content — a hash, never the bytes. */
  digest: z.string().optional(),
  /** Git sha of the checkpoint that preserved the content, when one was written. */
  checkpointSha: z.string().optional(),
  /**
   * Which arm of a content-preservation post-condition failed — content went
   * missing, content was reordered, or content was over-multiplied. Recovery is
   * identical for all of them, so nothing else in-process tells them apart per
   * occurrence, and the over-multiplication arm is the field signature of
   * duplicated content: to a user that reads as content APPEARING rather than
   * vanishing, the opposite complaint from the same event. Open string on read
   * so a future verdict parses on an older reader.
   */
  which: z.string().optional(),
  /**
   * Whether a converged fragment witness was published when a tolerance
   * decision was made. Separates "observers published no witness, so the
   * tolerance could not be evaluated at all" from "the guard ran against a real
   * witness and declined to protect the content" — two different defects with
   * two different fixes, previously indistinguishable from the ring alone.
   */
  witnessAvailable: z.boolean().optional(),
  /**
   * Client connections attached to the document when the event fired. A
   * destructive repair with nobody attached is invisible background hygiene;
   * the same repair under an attached editor is the instant a user's view
   * changes underneath them. Not a focus signal — the server cannot observe
   * focus — so it bounds the blast radius rather than proving impact.
   */
  connections: z.number().optional(),
});

export type LossCaptureEvent = z.infer<typeof LossCaptureEventSchema>;

/**
 * What a producer supplies to {@link LossCaptureRing.record}. The ring stamps
 * `ts`, `schemaVersion`, and the per-doc `seq`; everything else the producer
 * fills. `event` is the closed producer vocabulary — new kinds extend
 * {@link LOSS_EVENT_KINDS}.
 */
export interface LossCaptureEventInput {
  event: LossEventKind;
  docName: string;
  writerId: string | null;
  site?: string;
  direction?: string;
  lostLen?: number;
  digest?: string;
  checkpointSha?: string;
  /**
   * Closed producer vocabulary bound to the merge post-condition's own verdict
   * type, so a new arm there is a compile error here rather than a silently
   * unrecorded one; the read schema keeps it an open string.
   */
  which?: BridgeMergeContentLossWhich;
  witnessAvailable?: boolean;
  connections?: number;
}

const LOSS_CAPTURE_SUBDIR = ['.ok', 'local', 'loss-capture'] as const;
const LOSS_CURRENT_FILENAME = 'loss-current.jsonl';
const LOSS_PREVIOUS_FILENAME = 'loss-prev.jsonl';

/** Active loss-capture file path under `<projectDir>/.ok/local/loss-capture/`. */
export function lossCaptureCurrentPath(projectDir: string): string {
  return join(projectDir, ...LOSS_CAPTURE_SUBDIR, LOSS_CURRENT_FILENAME);
}

/** Previous-generation loss-capture file path. */
export function lossCapturePreviousPath(projectDir: string): string {
  return join(projectDir, ...LOSS_CAPTURE_SUBDIR, LOSS_PREVIOUS_FILENAME);
}

export interface LossCaptureRingOpts {
  /** Project root (where `.ok/` lives). */
  projectDir: string;
  /** Rotation threshold for `loss-current.jsonl`. */
  maxBytes: number;
  /**
   * Clock source. Injected because time is a system boundary — tests pin it for
   * deterministic `ts` stamps. Defaults to `Date.now`.
   */
  now?: () => number;
}

/**
 * Serialize `raw` (the contents of one loss-capture file) into events, oldest
 * first. Lines that fail to `JSON.parse` are skipped — the appender's SIGKILL
 * contract can leave one partial trailing line, and repair is the reader's job.
 * A row whose `event` kind or `schemaVersion` an older reader does not
 * recognize still parses; any unknown extra field is dropped.
 */
export function parseLossCaptureLines(raw: string): LossCaptureEvent[] {
  const out: LossCaptureEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = LossCaptureEventSchema.safeParse(json);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * Append-only ring for loss-class events. One instance per project; wiring
 * gates construction on the `lossCapture.enabled` config leaf, so a disabled
 * ring is simply never built. `record()` is best-effort — a failed diagnostic
 * write is logged and swallowed, never propagated into the caller's write path.
 */
export class LossCaptureRing {
  readonly #appender: RotatingAppender;
  readonly #now: () => number;
  // In-memory per-doc counter, so a file rotation (which renames the file) does
  // not reset the sequence — the counter lives with the process, not the file.
  readonly #seqByDoc = new Map<string, number>();

  constructor(opts: LossCaptureRingOpts) {
    this.#appender = new RotatingAppender({
      currentPath: lossCaptureCurrentPath(opts.projectDir),
      previousPath: lossCapturePreviousPath(opts.projectDir),
      maxBytes: opts.maxBytes,
    });
    this.#now = opts.now ?? Date.now;
  }

  /**
   * Record one loss-class event. Resolves once the write settles (or its
   * failure is logged); never rejects, so a producer can fire-and-forget from a
   * hot path. The `seq` is assigned synchronously at call time, so event order
   * on disk matches call order regardless of when the async write completes.
   */
  record(input: LossCaptureEventInput): Promise<void> {
    const seq = (this.#seqByDoc.get(input.docName) ?? 0) + 1;
    this.#seqByDoc.set(input.docName, seq);
    const event: LossCaptureEvent = {
      ts: this.#now(),
      schemaVersion: LOSS_CAPTURE_SCHEMA_VERSION,
      seq,
      event: input.event,
      docName: input.docName,
      writerId: input.writerId,
      ...(input.site !== undefined ? { site: input.site } : {}),
      ...(input.direction !== undefined ? { direction: input.direction } : {}),
      ...(input.lostLen !== undefined ? { lostLen: input.lostLen } : {}),
      ...(input.digest !== undefined ? { digest: input.digest } : {}),
      ...(input.checkpointSha !== undefined ? { checkpointSha: input.checkpointSha } : {}),
      ...(input.which !== undefined ? { which: input.which } : {}),
      ...(input.witnessAvailable !== undefined ? { witnessAvailable: input.witnessAvailable } : {}),
      ...(input.connections !== undefined ? { connections: input.connections } : {}),
    };
    return this.#appender.append(`${JSON.stringify(event)}\n`).catch((err: unknown) => {
      log.warn({ event: input.event, err }, '[loss-capture] failed to write loss-class event');
    });
  }

  /** Resolve once any enqueued writes have settled — for tests + shutdown. */
  async drain(): Promise<void> {
    await this.#appender.drain();
  }
}
