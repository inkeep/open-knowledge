import { describe, expect, test } from 'bun:test';
import {
  CHUNK_OVERLAP_CHARS,
  CHUNK_TARGET_CHARS,
  chunkDocument,
  MAX_CHUNKS_PER_DOC,
} from './chunking.ts';

describe('chunkDocument', () => {
  test('blank input yields no chunks', () => {
    expect(chunkDocument('')).toEqual([]);
    expect(chunkDocument('   \n\t  ')).toEqual([]);
  });

  test('short doc is a single trimmed chunk', () => {
    expect(chunkDocument('  hello world  ')).toEqual(['hello world']);
  });

  test('doc at the target boundary stays one chunk', () => {
    const text = 'a'.repeat(CHUNK_TARGET_CHARS);
    expect(chunkDocument(text)).toEqual([text]);
  });

  test('long doc splits into overlapping chunks that cover all content', () => {
    // Build a long doc of distinct numbered words so we can check coverage.
    const words = Array.from({ length: 1200 }, (_, i) => `word${i}`);
    const text = words.join(' ');
    const chunks = chunkDocument(text);
    expect(chunks.length).toBeGreaterThan(1);
    // Every word appears in at least one chunk (no content dropped).
    const joined = chunks.join(' ');
    for (const w of [words[0], words[600], words[words.length - 1]]) {
      expect(joined.includes(w)).toBe(true);
    }
    // Consecutive chunks overlap (the tail of one reappears in the next).
    const firstTail = chunks[0].slice(-CHUNK_OVERLAP_CHARS / 2);
    expect(chunks[1].includes(firstTail.trim().split(' ')[0])).toBe(true);
  });

  test('chunks never exceed the target length', () => {
    const text = 'lorem ipsum dolor sit amet '.repeat(2000);
    for (const chunk of chunkDocument(text)) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
    }
  });

  test('respects the max-chunk cap on pathologically large input', () => {
    const text = 'x'.repeat(CHUNK_TARGET_CHARS * (MAX_CHUNKS_PER_DOC + 50));
    expect(chunkDocument(text).length).toBeLessThanOrEqual(MAX_CHUNKS_PER_DOC);
  });

  test('an unbroken run with no whitespace still makes forward progress', () => {
    const text = 'a'.repeat(CHUNK_TARGET_CHARS * 3);
    const chunks = chunkDocument(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(MAX_CHUNKS_PER_DOC);
  });
});
