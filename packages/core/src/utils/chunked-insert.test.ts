import { describe, expect, test } from 'bun:test';
import {
  ChunkedInsertError,
  chunkedYTextInsert,
  DEFAULT_CHUNK_SIZE_BYTES,
  DEFAULT_CHUNK_THRESHOLD_BYTES,
  type InsertableYDoc,
  type InsertableYText,
} from './chunked-insert.ts';

interface FakeYText extends InsertableYText {
  content: string;
  inserts: Array<{ index: number; text: string }>;
}

interface FakeYDoc extends InsertableYDoc {
  transactions: number;
  lastOrigin: unknown;
}

function makeFake(): { doc: FakeYDoc; text: FakeYText } {
  const text: FakeYText = {
    content: '',
    inserts: [],
    get length() {
      return this.content.length;
    },
    insert(index: number, value: string) {
      this.content = this.content.slice(0, index) + value + this.content.slice(index);
      this.inserts.push({ index, text: value });
    },
  };
  const doc: FakeYDoc = {
    transactions: 0,
    lastOrigin: undefined,
    transact<T>(fn: () => T, origin?: unknown): T {
      doc.transactions++;
      doc.lastOrigin = origin;
      return fn();
    },
  };
  return { doc, text };
}

describe('chunkedYTextInsert — FR-21 large-paste chunking', () => {
  test('100KB payload → single transaction, no yields', async () => {
    const { doc, text } = makeFake();
    const payload = 'a'.repeat(100 * 1024);
    let yieldCount = 0;
    const yieldFn = async () => {
      yieldCount++;
    };
    await chunkedYTextInsert(doc, text, 0, payload, { yieldFn });
    expect(doc.transactions).toBe(1);
    expect(yieldCount).toBe(0);
    expect(text.content).toBe(payload);
  });

  test('501KB payload → multiple transactions with yields between', async () => {
    const { doc, text } = makeFake();
    const payload = 'a'.repeat(501 * 1024);
    let yieldCount = 0;
    const yieldFn = async () => {
      yieldCount++;
    };
    await chunkedYTextInsert(doc, text, 0, payload, { yieldFn });
    expect(doc.transactions).toBeGreaterThanOrEqual(2);
    expect(yieldCount).toBe(doc.transactions - 1);
    expect(text.content).toBe(payload);
  });

  test('1MB payload → insertion order preserved (monotonic writeIndex)', async () => {
    const { doc, text } = makeFake();
    const payload = `start${'x'.repeat(1024 * 1024 - 'start'.length - 'end'.length)}end`;
    await chunkedYTextInsert(doc, text, 0, payload, { yieldFn: async () => {} });
    expect(text.content.startsWith('start')).toBe(true);
    expect(text.content.endsWith('end')).toBe(true);
    expect(text.content.length).toBe(payload.length);
  });

  test('chunk-size constant tunable via options', async () => {
    const { doc, text } = makeFake();
    const payload = 'a'.repeat(300 * 1024);
    await chunkedYTextInsert(doc, text, 0, payload, {
      thresholdBytes: 10 * 1024,
      chunkSizeBytes: 50 * 1024,
      yieldFn: async () => {},
    });
    expect(doc.transactions).toBe(6);
  });

  test('default threshold + chunk-size constants exported for tuning', () => {
    expect(DEFAULT_CHUNK_THRESHOLD_BYTES).toBe(500 * 1024);
    expect(DEFAULT_CHUNK_SIZE_BYTES).toBe(50 * 1024);
  });

  test('origin is passed through on every chunk', async () => {
    const { doc, text } = makeFake();
    const payload = 'a'.repeat(300 * 1024);
    const ORIGIN = { name: 'test-origin' };
    await chunkedYTextInsert(doc, text, 0, payload, {
      thresholdBytes: 10 * 1024,
      chunkSizeBytes: 50 * 1024,
      yieldFn: async () => {},
      origin: ORIGIN,
    });
    expect(doc.lastOrigin).toBe(ORIGIN);
  });

  test('non-zero insertAt preserves surrounding content', async () => {
    const { doc, text } = makeFake();
    text.content = 'abcXYZ';
    const payload = 'INSERTED';
    await chunkedYTextInsert(doc, text, 3, payload, { yieldFn: async () => {} });
    expect(text.content).toBe('abcINSERTEDXYZ');
  });

  test('mid-stream failure throws ChunkedInsertError with partial-progress info', async () => {
    let callCount = 0;
    const failingText: InsertableYText = {
      get length() {
        return 0;
      },
      insert(_index: number, _value: string) {
        callCount++;
        if (callCount === 3) throw new Error('simulated Y.Text failure');
      },
    };
    const doc: InsertableYDoc = {
      transact<T>(fn: () => T) {
        return fn();
      },
    };
    const payload = 'a'.repeat(300 * 1024); // 6 chunks at 50KB
    let caught: unknown;
    try {
      await chunkedYTextInsert(doc, failingText, 0, payload, {
        thresholdBytes: 10 * 1024,
        chunkSizeBytes: 50 * 1024,
        yieldFn: async () => {},
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ChunkedInsertError);
    const cie = caught as ChunkedInsertError;
    expect(cie.chunksCompleted).toBe(2);
    expect(cie.totalChunks).toBe(6);
    expect(cie.bytesWritten).toBe(100 * 1024);
    expect(cie.bytesRemaining).toBe(200 * 1024);
    expect(cie.cause).toBeInstanceOf(Error);
  });

  test('resolveOffset callback re-resolves absolute index per chunk', async () => {
    const { doc, text } = makeFake();
    const payload = 'a'.repeat(150 * 1024);
    let chunkIdx = 0;
    const resolvedOffsets: number[] = [];
    await chunkedYTextInsert(doc, text, 0, payload, {
      thresholdBytes: 10 * 1024,
      chunkSizeBytes: 50 * 1024,
      yieldFn: async () => {},
      resolveOffset: (logical) => {
        const resolved = logical + chunkIdx * 2; // each prior yield += 2 external chars
        resolvedOffsets.push(resolved);
        chunkIdx++;
        return resolved;
      },
    });
    expect(resolvedOffsets).toEqual([0, 50 * 1024 + 2, 100 * 1024 + 4]);
  });
});
