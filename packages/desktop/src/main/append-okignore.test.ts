import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendOkIgnoreSync } from './append-okignore.ts';

describe('appendOkIgnoreSync', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ok-append-okignore-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test('empty-string patterns is a no-op (file is not created)', () => {
    appendOkIgnoreSync(dir, '');
    expect(existsSync(join(dir, '.okignore'))).toBe(false);
  });

  test('whitespace-only patterns is a no-op (file is not created)', () => {
    appendOkIgnoreSync(dir, '   \n\t  ');
    expect(existsSync(join(dir, '.okignore'))).toBe(false);
  });

  test('file-doesn-t-exist path: writes the patterns followed by exactly one trailing newline (no leading blank line)', () => {
    appendOkIgnoreSync(dir, 'tmp/\n*.draft.md');
    const out = readFileSync(join(dir, '.okignore'), 'utf8');
    expect(out).toBe('tmp/\n*.draft.md\n');
    expect(out.startsWith('\n')).toBe(false);
  });

  test('existing file with trailing newline: a one-line gap separates the prior content from the new patterns', () => {
    writeFileSync(join(dir, '.okignore'), 'node_modules/\n', 'utf8');
    appendOkIgnoreSync(dir, 'tmp/');
    const out = readFileSync(join(dir, '.okignore'), 'utf8');
    expect(out).toBe('node_modules/\n\ntmp/\n');
  });

  test('existing file without trailing newline: prior line is closed before the one-line gap', () => {
    writeFileSync(join(dir, '.okignore'), 'node_modules/', 'utf8');
    appendOkIgnoreSync(dir, 'tmp/');
    const out = readFileSync(join(dir, '.okignore'), 'utf8');
    expect(out).toBe('node_modules/\n\ntmp/\n');
  });

  test('whitespace at the edges of patterns is trimmed before append', () => {
    appendOkIgnoreSync(dir, '   tmp/\n*.draft.md   ');
    const out = readFileSync(join(dir, '.okignore'), 'utf8');
    expect(out).toBe('tmp/\n*.draft.md\n');
  });

  test('input lines that already appear in the existing file are filtered out', () => {
    writeFileSync(join(dir, '.okignore'), 'tmp/\n', 'utf8');
    appendOkIgnoreSync(dir, 'tmp/\nfoo/');
    const out = readFileSync(join(dir, '.okignore'), 'utf8');
    expect(out).toBe('tmp/\n\nfoo/\n');
  });

  test('input fully present in existing file is a complete no-op (file unchanged)', () => {
    const before = '# header comment\n#\ntmp/\n*.draft.md\n';
    writeFileSync(join(dir, '.okignore'), before, 'utf8');
    appendOkIgnoreSync(dir, '# header comment\n#\ntmp/\n*.draft.md');
    expect(readFileSync(join(dir, '.okignore'), 'utf8')).toBe(before);
  });

  test('seed-comment block re-supplied on top of a seeded file does not duplicate (exact-overlap → early return)', () => {
    // The consent dialog's
    // "Ignore patterns" textarea is filled (paste / mis-call) with the same
    // seed header `ok init` already wrote to disk. Every input line is a
    // duplicate, so `toAppend.length === 0` early-returns and the file is
    // left byte-identical — never even rewritten.
    const seed = [
      '# .okignore — paths to exclude from the OpenKnowledge document index.',
      '# Uses gitignore syntax (parsed by the `ignore` npm library), evaluated',
      '# alongside .gitignore in a single ignore-lib instance.',
      '#',
      '# Patterns combine with .gitignore: an entry here adds to exclusions, and',
      '# a leading `!` re-includes a file that .gitignore excluded.',
      '# Nested .okignore files at any folder depth are honored (mirrors .gitignore).',
      '#',
      '# Examples:',
      '#   drafts/        # exclude a directory',
      '#   *.draft.md     # exclude files matching a pattern',
      '#   !keep.md       # re-include a file .gitignore excluded',
      '',
    ].join('\n');
    writeFileSync(join(dir, '.okignore'), seed, 'utf8');
    appendOkIgnoreSync(dir, seed);
    expect(readFileSync(join(dir, '.okignore'), 'utf8')).toBe(seed);
  });

  test('seed-comment block plus one genuinely new pattern: seed lines drop, separator+new pattern land (paste-then-type shape)', () => {
    // User pastes the seed header into the consent
    // dialog's textarea AND types one new pattern below it. This exercises
    // the separator+write path (the all-duplicate input only hits the early-return). The
    // seed lines all collide in the trim-set and drop; the new pattern
    // survives and gets appended with the standard `\n` separator (file
    // ends with `\n`, so single-newline separator).
    const seed = [
      '# .okignore — paths to exclude from the OpenKnowledge document index.',
      '# Uses gitignore syntax (parsed by the `ignore` npm library), evaluated',
      '# alongside .gitignore in a single ignore-lib instance.',
      '#',
      '# Patterns combine with .gitignore: an entry here adds to exclusions, and',
      '# a leading `!` re-includes a file that .gitignore excluded.',
      '# Nested .okignore files at any folder depth are honored (mirrors .gitignore).',
      '#',
      '# Examples:',
      '#   drafts/        # exclude a directory',
      '#   *.draft.md     # exclude files matching a pattern',
      '#   !keep.md       # re-include a file .gitignore excluded',
      '',
    ].join('\n');
    writeFileSync(join(dir, '.okignore'), seed, 'utf8');
    appendOkIgnoreSync(dir, `${seed}*.scratch.md`);
    expect(readFileSync(join(dir, '.okignore'), 'utf8')).toBe(`${seed}\n*.scratch.md\n`);
  });

  test('repeat call with the same patterns leaves the file unchanged on the second run', () => {
    appendOkIgnoreSync(dir, 'tmp/\n*.draft.md');
    const first = readFileSync(join(dir, '.okignore'), 'utf8');
    appendOkIgnoreSync(dir, 'tmp/\n*.draft.md');
    const second = readFileSync(join(dir, '.okignore'), 'utf8');
    expect(second).toBe(first);
  });

  test('mixed input keeps only the genuinely new lines', () => {
    writeFileSync(join(dir, '.okignore'), 'tmp/\nfoo/\n', 'utf8');
    appendOkIgnoreSync(dir, 'foo/\nbar/\ntmp/\nbaz/');
    const out = readFileSync(join(dir, '.okignore'), 'utf8');
    expect(out).toBe('tmp/\nfoo/\n\nbar/\nbaz/\n');
  });

  test('trim-equality matches lines with trailing whitespace as duplicates', () => {
    writeFileSync(join(dir, '.okignore'), 'tmp/\n', 'utf8');
    appendOkIgnoreSync(dir, 'tmp/   \nfoo/');
    const out = readFileSync(join(dir, '.okignore'), 'utf8');
    expect(out).toBe('tmp/\n\nfoo/\n');
  });

  test('within-input repeats are NOT deduped (existing-line set is built once at entry, not refreshed per input line)', () => {
    // Docstring pin: dedup is cross-call only. Callers that need
    // within-input dedup must pre-dedupe — the existing-line set never
    // observes input lines. Use a non-empty existing that does NOT contain
    // `tmp/` so both input lines pass the filter because the set genuinely
    // doesn't see them (vs. the weaker empty-file case where the set
    // contains only `''`).
    writeFileSync(join(dir, '.okignore'), 'foo/\n', 'utf8');
    appendOkIgnoreSync(dir, 'tmp/\ntmp/');
    const out = readFileSync(join(dir, '.okignore'), 'utf8');
    expect(out).toBe('foo/\n\ntmp/\ntmp/\n');
  });
});
