import { join } from 'node:path';
import type { BridgeMergeContentLossWhich } from '@inkeep/open-knowledge-core';
import { z } from 'zod';
import { getLogger } from './logger.ts';
import { RotatingAppender } from './telemetry-file-sink.ts';

const log = getLogger('loss-capture');

export const LOSS_CAPTURE_SCHEMA_VERSION = 1;

export const LOSS_EVENT_GUARD_DEFER = 'guard-defer';
export const LOSS_EVENT_DETECTOR_TRIP = 'detector-trip';
export const LOSS_EVENT_BACKSTOP_TRIP = 'backstop-trip';
export const LOSS_EVENT_CHECKPOINT_WRITE = 'checkpoint-write';
export const LOSS_EVENT_PERSISTENCE_HOLD = 'persistence-hold';
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

export const LossCaptureEventSchema = z.object({
  ts: z.number(),
  schemaVersion: z.number(),
  seq: z.number(),
  event: z.string(),
  docName: z.string(),
  writerId: z.string().nullable(),
  site: z.string().optional(),
  direction: z.string().optional(),
  lostLen: z.number().optional(),
  digest: z.string().optional(),
  checkpointSha: z.string().optional(),
  which: z.string().optional(),
  witnessAvailable: z.boolean().optional(),
  connections: z.number().optional(),
});

export type LossCaptureEvent = z.infer<typeof LossCaptureEventSchema>;

export interface LossCaptureEventInput {
  event: LossEventKind;
  docName: string;
  writerId: string | null;
  site?: string;
  direction?: string;
  lostLen?: number;
  digest?: string;
  checkpointSha?: string;
  which?: BridgeMergeContentLossWhich;
  witnessAvailable?: boolean;
  connections?: number;
}

const LOSS_CAPTURE_SUBDIR = ['.ok', 'local', 'loss-capture'] as const;
const LOSS_CURRENT_FILENAME = 'loss-current.jsonl';
const LOSS_PREVIOUS_FILENAME = 'loss-prev.jsonl';

export function lossCaptureCurrentPath(projectDir: string): string {
  return join(projectDir, ...LOSS_CAPTURE_SUBDIR, LOSS_CURRENT_FILENAME);
}

export function lossCapturePreviousPath(projectDir: string): string {
  return join(projectDir, ...LOSS_CAPTURE_SUBDIR, LOSS_PREVIOUS_FILENAME);
}

export interface LossCaptureRingOpts {
  projectDir: string;
  maxBytes: number;
  now?: () => number;
}

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

export class LossCaptureRing {
  readonly #appender: RotatingAppender;
  readonly #now: () => number;
  readonly #seqByDoc = new Map<string, number>();

  constructor(opts: LossCaptureRingOpts) {
    this.#appender = new RotatingAppender({
      currentPath: lossCaptureCurrentPath(opts.projectDir),
      previousPath: lossCapturePreviousPath(opts.projectDir),
      maxBytes: opts.maxBytes,
    });
    this.#now = opts.now ?? Date.now;
  }

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

  async drain(): Promise<void> {
    await this.#appender.drain();
  }
}
