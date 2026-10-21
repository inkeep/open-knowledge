import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DiskReceiptLog, receiptFileIsGoneIn } from './disk-receipts.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import { contentHash } from './version-hash.ts';

let dir: string;
let path: string;

beforeEach(() => {
  resetMetrics();
  dir = mkdtempSync(join(tmpdir(), 'ok-disk-receipts-'));
  path = join(dir, '.ok', 'local', 'receipts.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function persistedLines(): Record<string, unknown>[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const observation = {
  size: 7n,
  mtimeNs: 1_700_000_000_123_456_789n,
  dev: 16777220n,
  ino: 2n ** 60n,
};

describe('DiskReceiptLog', () => {
  test('a recorded receipt carries the content hash, byte size and file identity, and survives a reload', () => {
    const log = new DiskReceiptLog({ path, now: () => 42 });
    log.recordOwnWrite('notes/a', 'héllo\n', observation);

    const reloaded = new DiskReceiptLog({ path });
    expect(reloaded.get('notes/a')).toEqual({
      hash: contentHash('héllo\n'),
      size: Buffer.byteLength('héllo\n'),
      mtimeNs: '1700000000123456789',
      dev: '16777220',
      ino: (2n ** 60n).toString(),
      at: 42,
      via: 'own-write',
    });
  });

  test('a receipt recorded without an observation has no identity or timestamp', () => {
    const log = new DiskReceiptLog({ path });
    log.recordAgreed('doc', 'agreed bytes\n');
    expect(log.get('doc')).toMatchObject({ mtimeNs: null, dev: null, ino: null, via: 'agreed' });
  });

  test('the last record for a document wins and a delete removes it across a reload', () => {
    const log = new DiskReceiptLog({ path });
    log.recordAgreed('kept', 'one\n');
    log.recordAgreed('kept', 'two\n');
    log.recordAgreed('gone', 'bytes\n');
    log.forget('gone');

    const reloaded = new DiskReceiptLog({ path });
    expect(reloaded.get('kept')?.hash).toBe(contentHash('two\n'));
    expect(reloaded.get('gone')).toBeUndefined();
  });

  test('recording the same bytes again appends nothing', () => {
    const log = new DiskReceiptLog({ path });
    const sameObservation = { ...observation, size: BigInt(Buffer.byteLength('same\n')) };
    log.recordAgreed('doc', 'same\n', sameObservation);
    log.recordAgreed('doc', 'same\n');
    log.recordAgreed('doc', 'same\n', sameObservation);
    expect(persistedLines()).toHaveLength(1);
  });

  test('loading compacts superseded lines and tombstones away', () => {
    const log = new DiskReceiptLog({ path });
    log.recordAgreed('a', '1\n');
    log.recordAgreed('a', '2\n');
    log.recordAgreed('b', '1\n');
    log.forget('b');
    expect(persistedLines()).toHaveLength(4);

    new DiskReceiptLog({ path });
    expect(persistedLines()).toEqual([
      expect.objectContaining({ doc: 'a', hash: contentHash('2\n') }),
    ]);
  });

  test('torn and malformed records are skipped and counted, records from another schema version are kept unread, and the rest still load', () => {
    mkdirSync(join(dir, '.ok', 'local'), { recursive: true });
    const valid = {
      v: 1,
      doc: 'good',
      hash: contentHash('ok\n'),
      size: 3,
      mtimeNs: null,
      dev: null,
      ino: null,
      at: 1,
      via: 'agreed',
    };
    const future = JSON.stringify({ v: 2, doc: 'future', digest: 'from a newer build' });
    writeFileSync(
      path,
      [
        JSON.stringify(valid),
        future,
        JSON.stringify({ ...valid, doc: 'bad-hash', hash: 'nope' }),
        '{"v":1,"doc":"torn","ha',
      ].join('\n'),
    );

    const log = new DiskReceiptLog({ path });
    expect(log.get('good')?.hash).toBe(contentHash('ok\n'));
    expect(log.get('future')).toBeUndefined();
    expect(log.get('bad-hash')).toBeUndefined();
    expect(log.get('torn')).toBeUndefined();
    expect(getMetrics().receiptRecordsUnreadable).toBe(2);
    expect(getMetrics().receiptRecordsOtherVersion).toBe(1);
    expect(readFileSync(path, 'utf-8').split('\n')).toContain(future);

    log.recordAgreed('later', 'x\n');
    new DiskReceiptLog({ path });
    expect(readFileSync(path, 'utf-8').split('\n')).toContain(future);
  });

  test('a symbolic link at the receipt log path is neither followed nor replaced, and receipts stay in memory', () => {
    mkdirSync(join(dir, '.ok', 'local'), { recursive: true });
    const target = join(dir, 'outside-target.jsonl');
    symlinkSync(target, path);

    const log = new DiskReceiptLog({ path });
    log.recordAgreed('doc', 'bytes\n');
    log.forget('doc');
    log.recordOwnWrite('doc', 'again\n');

    expect(existsSync(target)).toBe(false);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(log.get('doc')?.hash).toBe(contentHash('again\n'));
    expect(getMetrics().receiptLogRefused).toBe(1);
  });

  test('a receipt log that cannot be persisted keeps receipts in memory and counts the failure', () => {
    writeFileSync(join(dir, 'blocker'), 'a file where the state folder should be');
    const log = new DiskReceiptLog({ path: join(dir, 'blocker', 'receipts.jsonl') });
    log.recordAgreed('doc', 'bytes\n');
    expect(log.get('doc')?.hash).toBe(contentHash('bytes\n'));
    expect(getMetrics().receiptPersistFailures).toBe(1);
  });

  test('recent own writes are remembered by count, newest kept, and forgotten with the receipt', () => {
    const log = new DiskReceiptLog();
    for (let i = 0; i < 10; i++) log.recordOwnWrite('doc', `v${i}\n`);
    expect(log.isRecentOwnWrite('doc', contentHash('v9\n'))).toBe(true);
    expect(log.isRecentOwnWrite('doc', contentHash('v2\n'))).toBe(true);
    expect(log.isRecentOwnWrite('doc', contentHash('v1\n'))).toBe(false);
    log.recordAgreed('doc', 'outside\n');
    expect(log.isRecentOwnWrite('doc', contentHash('outside\n'))).toBe(false);
    log.forget('doc');
    expect(log.isRecentOwnWrite('doc', contentHash('v9\n'))).toBe(false);
  });

  test('a receipt counts as gone only when no file the document could live in exists', () => {
    const content = join(dir, 'content');
    mkdirSync(join(content, 'diagrams'), { recursive: true });
    writeFileSync(join(content, 'notes.md'), '# Notes\n');
    writeFileSync(join(content, 'diagrams', 'flow.mmd'), 'graph TD\n');
    writeFileSync(join(content, 'value.ts'), 'export {};\n');
    const isGone = receiptFileIsGoneIn(content);

    expect(isGone('notes')).toBe(false);
    expect(isGone('diagrams/flow.mmd')).toBe(false);
    expect(isGone('value.ts')).toBe(false);
    expect(isGone('gone')).toBe(true);
    expect(isGone('diagrams/gone.mmd')).toBe(true);
    expect(isGone('__skill__/global/demo')).toBe(false);
    expect(isGone('__config__/project')).toBe(false);
    expect(isGone('../outside')).toBe(false);
  });

  test('pruning drops receipts whose file is gone and rewrites the log without them', () => {
    const log = new DiskReceiptLog({ path });
    log.recordAgreed('present', 'a\n');
    log.recordAgreed('missing', 'b\n');
    expect(log.pruneGone((docName) => docName === 'missing')).toBe(1);
    expect(log.get('missing')).toBeUndefined();
    expect(persistedLines().map((line) => line.doc)).toEqual(['present']);
  });
});
