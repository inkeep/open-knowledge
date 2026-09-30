import { describe, expect, test } from 'vitest';
import {
  canonicalPathKey,
  indexPathsByCanonicalKey,
  matchStoredPath,
  resolveStoredPath,
} from './canonical-path.ts';

const NFC_E = '\u00E9';
const NFD_E = '\u0065\u0301';

describe('canonicalPathKey', () => {
  test('composes a decomposed letter and leaves an already composed letter in place', () => {
    expect(canonicalPathKey(`Ren${NFD_E}`)).toBe(`Ren${NFC_E}`);
    expect(canonicalPathKey(`Ren${NFC_E}`)).toBe(`Ren${NFC_E}`);
  });

  test('does not fold compatibility lookalikes', () => {
    expect(canonicalPathKey('\uFB01le')).toBe('\uFB01le');
    expect(canonicalPathKey('\uFB01le')).not.toBe('file');
    expect(canonicalPathKey('\u00B2')).toBe('\u00B2');
    expect(canonicalPathKey('\u00B2')).not.toBe('2');
  });

  test('folds a canonical singleton the way NFC does', () => {
    expect(canonicalPathKey('\u2126')).toBe('\u03A9');
  });
});

describe('resolveStoredPath', () => {
  test('returns the stored spelling for a canonically equal query', () => {
    const stored = `People/Ren${NFD_E}`;
    const paths = new Set([stored]);
    expect(resolveStoredPath(paths, `People/Ren${NFC_E}`)).toBe(stored);
  });

  test('returns the query itself when that spelling is stored, even if another spelling is too', () => {
    const nfc = `People/Ren${NFC_E}`;
    const nfd = `People/Ren${NFD_E}`;
    const paths = new Set([nfd, nfc]);
    expect(resolveStoredPath(paths, nfc)).toBe(nfc);
    expect(resolveStoredPath(paths, nfd)).toBe(nfd);
  });

  test('matches inside one segment and does not cross a slash', () => {
    const stored = `a/${NFC_E}`;
    const paths = new Set([stored, 'a/x']);
    expect(resolveStoredPath(paths, `a/${NFD_E}`)).toBe(stored);
    expect(resolveStoredPath(paths, `${NFD_E}/x`)).toBeNull();
  });

  test('does not treat a compatibility lookalike as the stored path', () => {
    const paths = new Set(['file', 'omega', '2', '\u03A9']);
    expect(resolveStoredPath(paths, '\uFB01le')).toBeNull();
    expect(resolveStoredPath(paths, '\u2126')).toBe('\u03A9');
    expect(resolveStoredPath(new Set(['\u2126']), '\u03A9')).toBe('\u2126');
    expect(resolveStoredPath(paths, '\u00B2')).toBeNull();
  });

  test('indexes the first stored spelling for a canonical key', () => {
    const nfd = `Ren${NFD_E}`;
    const nfc = `Ren${NFC_E}`;
    expect(indexPathsByCanonicalKey([nfd, nfc]).get(`Ren${NFC_E}`)).toBe(nfd);
  });

  test('keeps a cached index after the set is mutated, while an uncached match sees the add', () => {
    const stored = `People/Ren${NFD_E}`;
    const query = `People/Ren${NFC_E}`;
    const paths = new Set<string>();
    expect(resolveStoredPath(paths, query)).toBeNull();
    paths.add(stored);
    expect(resolveStoredPath(paths, query)).toBeNull();
    expect(matchStoredPath(paths, query)).toBe(stored);
  });
});
