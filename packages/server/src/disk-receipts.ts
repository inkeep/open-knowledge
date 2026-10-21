import { closeSync, constants, existsSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  CONFIG_DOC_NAMES,
  isEditableTextDocFile,
  isExcalidrawDocFile,
  isManagedArtifactDocName,
  isMermaidDocFile,
  SUPPORTED_DOC_EXTENSIONS,
  SYSTEM_DOC_NAME,
} from '@inkeep/open-knowledge-core';
import { atomicTempPath } from '@inkeep/open-knowledge-core/server';
import {
  tracedAppendNoFollowSync,
  tracedMkdirSync,
  tracedRenameSync,
  tracedUnlinkSync,
  tracedWriteFileSync,
} from './fs-traced.ts';
import { errnoCode } from './http/handler-utils.ts';
import { getLogger } from './logger.ts';
import {
  incrementReceiptLogRefused,
  incrementReceiptPersistFailures,
  incrementReceiptRecordsOtherVersion,
  incrementReceiptRecordsUnreadable,
} from './metrics.ts';
import { isWithinDir } from './path-utils.ts';
import { contentHash } from './version-hash.ts';

const DISK_RECEIPT_SCHEMA_VERSION = 1;

const RECENT_OWN_WRITE_LIMIT = 8;
const MIN_COMPACTION_LINES = 2048;
const COMPACTION_FACTOR = 4;

export interface FileObservation {
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface DiskReceipt {
  readonly hash: string;
  readonly size: number;
  readonly mtimeNs: string | null;
  readonly dev: string | null;
  readonly ino: string | null;
  readonly at: number;
  readonly via: 'own-write' | 'agreed';
}

interface PersistedReceipt extends DiskReceipt {
  readonly v: typeof DISK_RECEIPT_SCHEMA_VERSION;
  readonly doc: string;
}

interface PersistedTombstone {
  readonly v: typeof DISK_RECEIPT_SCHEMA_VERSION;
  readonly doc: string;
  readonly gone: true;
  readonly at: number;
}

interface DiskReceiptLogOptions {
  path?: string;
  now?: () => number;
}

const log = getLogger('disk-receipts');

function isNullableDecimal(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^\d+$/.test(value));
}

type ParsedLine = PersistedReceipt | PersistedTombstone | 'other-version' | null;

function parseLine(line: string): ParsedLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.doc !== 'string') return null;
  if (typeof record.v === 'number' && record.v !== DISK_RECEIPT_SCHEMA_VERSION) {
    return 'other-version';
  }
  if (record.v !== DISK_RECEIPT_SCHEMA_VERSION) return null;
  if (typeof record.at !== 'number') return null;
  if (record.gone === true) {
    return { v: DISK_RECEIPT_SCHEMA_VERSION, doc: record.doc, gone: true, at: record.at };
  }
  if (
    typeof record.hash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(record.hash) ||
    typeof record.size !== 'number' ||
    !isNullableDecimal(record.mtimeNs) ||
    !isNullableDecimal(record.dev) ||
    !isNullableDecimal(record.ino) ||
    (record.via !== 'own-write' && record.via !== 'agreed')
  ) {
    return null;
  }
  return {
    v: DISK_RECEIPT_SCHEMA_VERSION,
    doc: record.doc,
    hash: record.hash,
    size: record.size,
    mtimeNs: record.mtimeNs,
    dev: record.dev,
    ino: record.ino,
    at: record.at,
    via: record.via,
  };
}

function isReservedReceiptName(docName: string): boolean {
  return (
    docName === SYSTEM_DOC_NAME ||
    (CONFIG_DOC_NAMES as readonly string[]).includes(docName) ||
    isManagedArtifactDocName(docName)
  );
}

function receiptFileCandidates(docName: string): string[] {
  const markdown = SUPPORTED_DOC_EXTENSIONS.map((extension) => `${docName}${extension}`);
  const ownPath =
    isMermaidDocFile(docName) || isExcalidrawDocFile(docName) || isEditableTextDocFile(docName);
  return ownPath ? [docName, ...markdown] : markdown;
}

export function receiptFileIsGoneIn(contentDir: string): (docName: string) => boolean {
  return (docName) => {
    if (isReservedReceiptName(docName)) return false;
    for (const relativePath of receiptFileCandidates(docName)) {
      const candidate = resolve(contentDir, relativePath);
      if (!isWithinDir(candidate, contentDir)) return false;
      try {
        lstatSync(candidate);
        return false;
      } catch (err) {
        const code = errnoCode(err);
        if (code !== 'ENOENT' && code !== 'ENOTDIR') return false;
      }
    }
    return true;
  };
}

function sameObservation(receipt: DiskReceipt, observation: FileObservation): boolean {
  return (
    receipt.size === Number(observation.size) &&
    receipt.mtimeNs === observation.mtimeNs.toString() &&
    receipt.dev === observation.dev.toString() &&
    receipt.ino === observation.ino.toString()
  );
}

export class DiskReceiptLog {
  private readonly receipts = new Map<string, DiskReceipt>();
  private readonly otherVersionLines: string[] = [];
  private readonly recentOwnWrites = new Map<string, string[]>();
  private readonly path: string | undefined;
  private readonly now: () => number;
  private linesSinceCompaction = 0;
  private directoryReady = false;
  private persistFailures = 0;
  private refused = false;

  constructor(options: DiskReceiptLogOptions = {}) {
    this.path = options.path;
    this.now = options.now ?? Date.now;
    this.load();
  }

  get(docName: string): DiskReceipt | undefined {
    return this.receipts.get(docName);
  }

  isRecentOwnWrite(docName: string, hash: string): boolean {
    return this.recentOwnWrites.get(docName)?.includes(hash) ?? false;
  }

  recordAgreed(docName: string, content: string, observation?: FileObservation): void {
    this.record(docName, content, 'agreed', observation);
  }

  recordOwnWrite(docName: string, content: string, observation?: FileObservation): void {
    this.record(docName, content, 'own-write', observation);
    const hash = contentHash(content);
    const recent = (this.recentOwnWrites.get(docName) ?? []).filter((entry) => entry !== hash);
    recent.push(hash);
    this.recentOwnWrites.set(docName, recent.slice(-RECENT_OWN_WRITE_LIMIT));
  }

  forget(docName: string): void {
    this.recentOwnWrites.delete(docName);
    if (!this.receipts.delete(docName)) return;
    this.append({ v: DISK_RECEIPT_SCHEMA_VERSION, doc: docName, gone: true, at: this.now() });
  }

  pruneGone(isGone: (docName: string) => boolean): number {
    let pruned = 0;
    for (const docName of this.receipts.keys()) {
      if (!isGone(docName)) continue;
      this.receipts.delete(docName);
      this.recentOwnWrites.delete(docName);
      pruned++;
    }
    if (pruned > 0) this.compact();
    return pruned;
  }

  private record(
    docName: string,
    content: string,
    via: DiskReceipt['via'],
    observation: FileObservation | undefined,
  ): void {
    const hash = contentHash(content);
    const existing = this.receipts.get(docName);
    if (
      existing?.hash === hash &&
      (observation === undefined || sameObservation(existing, observation))
    ) {
      return;
    }
    const receipt: DiskReceipt = {
      hash,
      size: Buffer.byteLength(content, 'utf8'),
      mtimeNs: observation ? observation.mtimeNs.toString() : null,
      dev: observation ? observation.dev.toString() : null,
      ino: observation ? observation.ino.toString() : null,
      at: this.now(),
      via,
    };
    this.receipts.set(docName, receipt);
    this.append({ v: DISK_RECEIPT_SCHEMA_VERSION, doc: docName, ...receipt });
  }

  private append(record: PersistedReceipt | PersistedTombstone): void {
    if (!this.path || this.refused) return;
    try {
      if (!this.directoryReady) {
        tracedMkdirSync(dirname(this.path), { recursive: true });
        this.directoryReady = true;
        if (this.refuseUnsafeLogPath()) return;
      }
      tracedAppendNoFollowSync(this.path, `${JSON.stringify(record)}\n`, 0o600);
      this.linesSinceCompaction++;
    } catch (err) {
      if (errnoCode(err) === 'ELOOP') {
        this.refuse('symlink');
        return;
      }
      this.reportPersistFailure(err, 'append');
      return;
    }
    if (
      this.linesSinceCompaction >
      Math.max(MIN_COMPACTION_LINES, COMPACTION_FACTOR * this.receipts.size)
    ) {
      this.compact();
    }
  }

  private compact(): void {
    if (!this.path || this.refused) return;
    const lines: string[] = [...this.otherVersionLines];
    for (const [docName, receipt] of this.receipts) {
      lines.push(JSON.stringify({ v: DISK_RECEIPT_SCHEMA_VERSION, doc: docName, ...receipt }));
    }
    const temporaryPath = atomicTempPath(this.path);
    try {
      tracedMkdirSync(dirname(this.path), { recursive: true });
      this.directoryReady = true;
      tracedWriteFileSync(temporaryPath, lines.length > 0 ? `${lines.join('\n')}\n` : '', {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
      });
      tracedRenameSync(temporaryPath, this.path);
      this.linesSinceCompaction = 0;
    } catch (err) {
      this.reportPersistFailure(err, 'compact');
      try {
        if (existsSync(temporaryPath)) tracedUnlinkSync(temporaryPath);
      } catch (cleanupErr) {
        log.warn({ err: cleanupErr }, '[disk-receipts] could not remove the compaction temp file');
      }
    }
  }

  private refuseUnsafeLogPath(): boolean {
    if (!this.path) return false;
    let stats: ReturnType<typeof lstatSync> | undefined;
    try {
      stats = lstatSync(this.path, { throwIfNoEntry: false });
    } catch (err) {
      if (errnoCode(err) === 'ENOTDIR') return false;
      this.reportPersistFailure(err, 'append');
      return false;
    }
    if (stats === undefined || stats.isFile()) return false;
    this.refuse(stats.isSymbolicLink() ? 'symlink' : 'not-a-file');
    return true;
  }

  private refuse(reason: 'symlink' | 'not-a-file'): void {
    this.refused = true;
    incrementReceiptLogRefused();
    log.warn(
      { reason },
      `[disk-receipts] the receipt log path is a ${reason === 'symlink' ? 'symbolic link' : 'non-regular file'}; it is neither read nor written, and receipts stay in memory for this run`,
    );
  }

  private readLog(): string | null {
    if (!this.path) return null;
    if (this.refuseUnsafeLogPath()) return null;
    let fd: number;
    try {
      fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT') return null;
      if (code === 'ELOOP') {
        this.refuse('symlink');
        return null;
      }
      incrementReceiptRecordsUnreadable();
      log.warn(
        { err },
        '[disk-receipts] receipt log unreadable; every document starts without a receipt',
      );
      return null;
    }
    try {
      return readFileSync(fd, 'utf-8');
    } catch (err) {
      incrementReceiptRecordsUnreadable();
      log.warn(
        { err },
        '[disk-receipts] receipt log unreadable; every document starts without a receipt',
      );
      return null;
    } finally {
      closeSync(fd);
    }
  }

  private load(): void {
    const raw = this.readLog();
    if (raw === null) return;
    let lines = 0;
    let unreadable = 0;
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      lines++;
      const record = parseLine(line);
      if (record === null) {
        unreadable++;
        continue;
      }
      if (record === 'other-version') {
        this.otherVersionLines.push(line);
        continue;
      }
      if ('gone' in record) {
        this.receipts.delete(record.doc);
        continue;
      }
      this.receipts.set(record.doc, {
        hash: record.hash,
        size: record.size,
        mtimeNs: record.mtimeNs,
        dev: record.dev,
        ino: record.ino,
        at: record.at,
        via: record.via,
      });
    }
    if (unreadable > 0) {
      incrementReceiptRecordsUnreadable(unreadable);
      log.warn(
        { unreadable, lines },
        `[disk-receipts] skipped ${unreadable} unreadable receipt record(s); those documents start without a receipt`,
      );
    }
    if (this.otherVersionLines.length > 0) {
      incrementReceiptRecordsOtherVersion(this.otherVersionLines.length);
      log.info(
        { otherVersion: this.otherVersionLines.length },
        `[disk-receipts] kept ${this.otherVersionLines.length} receipt record(s) written by another schema version without reading them`,
      );
    }
    if (lines !== this.receipts.size + this.otherVersionLines.length) this.compact();
  }

  private reportPersistFailure(err: unknown, operation: 'append' | 'compact'): void {
    incrementReceiptPersistFailures();
    this.persistFailures++;
    if (this.persistFailures === 1 || this.persistFailures % 100 === 0) {
      log.warn(
        { err, operation, failures: this.persistFailures },
        '[disk-receipts] could not persist the receipt log; receipts stay in memory for this run',
      );
    }
  }
}
