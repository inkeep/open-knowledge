import { type BigIntStats, statSync } from 'node:fs';
import type { FileObservation } from './disk-receipts.ts';
import { type ObservedFileRead, tracedReadObservedSync } from './fs-traced.ts';
import { errnoCode } from './http/handler-utils.ts';
import type { ReceiptIntakeSkip } from './metrics.ts';
import { contentHash } from './version-hash.ts';

export const COMPARE_READ_RETRY_DELAYS_MS: readonly number[] = [50, 200, 800];

const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);
const TRANSIENT_READ_CODES = new Set(['EBUSY', 'EAGAIN', 'EINTR', 'EMFILE', 'ENFILE']);
const WIN32_TRANSIENT_READ_CODES = new Set(['EPERM', 'EACCES']);

class FileChangedDuringReadError extends Error {
  readonly code = 'EAGAIN';

  constructor() {
    super('the file changed while it was being read for the pre-write compare');
    this.name = 'FileChangedDuringReadError';
  }
}

export class StoreRestatRefusedError extends Error {
  constructor(docName: string) {
    super(`the file for ${docName} changed between the pre-write compare and the rename`);
    this.name = 'StoreRestatRefusedError';
  }
}

export class StoreRestatFailedError extends Error {
  readonly code: string | undefined;

  constructor(docName: string, cause: unknown) {
    super(`the file for ${docName} could not be re-read before the rename`, { cause });
    this.name = 'StoreRestatFailedError';
    this.code = errnoCode(cause);
  }
}

export type DiskCompareOutcome =
  | {
      readonly kind: 'match';
      readonly observation: FileObservation;
      readonly alreadyCandidate: boolean;
    }
  | { readonly kind: 'drift'; readonly observation: FileObservation }
  | {
      readonly kind: 'changed';
      readonly text: string;
      readonly lossless: boolean;
      readonly observation: FileObservation;
    }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly error: unknown; readonly transient: boolean };

export function assertNeverDiskCompare(outcome: never): never {
  throw new Error(`unhandled disk compare outcome: ${(outcome as { kind: string }).kind}`);
}

export interface DiskCompareInput {
  readonly path: string;
  readonly receiptHash: string | undefined;
  readonly baseHash: string | undefined;
  readonly candidateHash: string;
}

export function isTransientReadError(
  err: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (err instanceof FileChangedDuringReadError) return true;
  const code = errnoCode(err);
  if (code === undefined) return false;
  if (TRANSIENT_READ_CODES.has(code)) return true;
  return platform === 'win32' && WIN32_TRANSIENT_READ_CODES.has(code);
}

export function observationOf(stats: BigIntStats): FileObservation {
  return { size: stats.size, mtimeNs: stats.mtimeNs, dev: stats.dev, ino: stats.ino };
}

function sameFileState(a: FileObservation, b: FileObservation): boolean {
  return a.size === b.size && a.mtimeNs === b.mtimeNs && a.dev === b.dev && a.ino === b.ino;
}

export function compareDiskBeforeReplace(
  input: DiskCompareInput,
  read: (path: string) => ObservedFileRead = tracedReadObservedSync,
  platform: NodeJS.Platform = process.platform,
): DiskCompareOutcome {
  let observed: ObservedFileRead;
  try {
    observed = read(input.path);
  } catch (error) {
    const code = errnoCode(error);
    if (code !== undefined && ABSENT_CODES.has(code)) return { kind: 'absent' };
    return { kind: 'unreadable', error, transient: isTransientReadError(error, platform) };
  }
  const observation = observationOf(observed.before);
  if (
    !sameFileState(observation, observationOf(observed.after)) ||
    BigInt(observed.bytes.byteLength) !== observed.before.size
  ) {
    return { kind: 'unreadable', error: new FileChangedDuringReadError(), transient: true };
  }
  const text = observed.bytes.toString('utf8');
  const diskHash = contentHash(text);
  const expected = input.receiptHash ?? input.baseHash;
  if (diskHash === input.candidateHash) {
    return { kind: 'match', observation, alreadyCandidate: true };
  }
  if (diskHash === expected) {
    return { kind: 'match', observation, alreadyCandidate: false };
  }
  if (input.baseHash !== undefined && diskHash === input.baseHash) {
    return { kind: 'drift', observation };
  }
  return {
    kind: 'changed',
    text,
    lossless: Buffer.from(text, 'utf8').equals(observed.bytes),
    observation,
  };
}

export type ObservedTextRead =
  | {
      readonly kind: 'read';
      readonly text: string;
      readonly lossless: boolean;
      readonly observation: FileObservation;
    }
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed'; readonly error: unknown };

export function readObservedText(
  path: string,
  read: (path: string) => ObservedFileRead = tracedReadObservedSync,
): ObservedTextRead {
  let observed: ObservedFileRead;
  try {
    observed = read(path);
  } catch (error) {
    const code = errnoCode(error);
    if (code !== undefined && ABSENT_CODES.has(code)) return { kind: 'absent' };
    return { kind: 'failed', error };
  }
  const text = observed.bytes.toString('utf8');
  return {
    kind: 'read',
    text,
    lossless: Buffer.from(text, 'utf8').equals(observed.bytes),
    observation: observationOf(observed.before),
  };
}

export type RestatOutcome =
  | { readonly kind: 'same' }
  | { readonly kind: 'moved' }
  | { readonly kind: 'failed'; readonly error: unknown };

export function restatFile(path: string, observation: FileObservation | null): RestatOutcome {
  let stats: BigIntStats | undefined;
  try {
    stats = statSync(path, { bigint: true });
  } catch (error) {
    const code = errnoCode(error);
    if (code === undefined || !ABSENT_CODES.has(code)) return { kind: 'failed', error };
    stats = undefined;
  }
  if (observation === null) return stats === undefined ? { kind: 'same' } : { kind: 'moved' };
  return stats !== undefined && sameFileState(observation, observationOf(stats))
    ? { kind: 'same' }
    : { kind: 'moved' };
}

export function statObservation(path: string): FileObservation | undefined {
  try {
    const stats = statSync(path, { bigint: true, throwIfNoEntry: false });
    return stats ? observationOf(stats) : undefined;
  } catch {
    return undefined;
  }
}

export type ReceiptIntakeDecision = 'own-write' | 'superseded' | 'outside';

export function classifyIntakeAgainstReceipt(input: {
  readonly receiptHash: string | undefined;
  readonly eventHash: string;
  readonly isRecentOwnWrite: boolean;
  readonly readDiskHash: () => string | null;
}): ReceiptIntakeDecision {
  if (input.receiptHash === undefined) return 'outside';
  if (input.eventHash === input.receiptHash) return 'own-write';
  if (input.isRecentOwnWrite && input.readDiskHash() === input.receiptHash) {
    return 'superseded';
  }
  return 'outside';
}

export function receiptIntakeSkipOf(decision: ReceiptIntakeDecision): ReceiptIntakeSkip | null {
  switch (decision) {
    case 'own-write':
      return 'echo';
    case 'superseded':
      return 'superseded';
    case 'outside':
      return null;
    default:
      return assertNeverIntakeDecision(decision);
  }
}

function assertNeverIntakeDecision(decision: never): never {
  throw new Error(`unhandled receipt intake decision: ${String(decision)}`);
}
