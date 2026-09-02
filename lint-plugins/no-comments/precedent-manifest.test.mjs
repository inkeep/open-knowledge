import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { classifyComment } from './allowlist.mjs';
import { extractComments } from './extract.mjs';
import { loadPrecedentNumbers } from './index.mjs';
import { parsePrecedentNumbers, UnvalidatedPrecedentRegistry } from './precedents.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MANIFEST_SUBJECT_ROOT = join(MODULE_DIR, '..', '..');
const manifest = new Set(
  JSON.parse(readFileSync(join(MODULE_DIR, 'precedent-numbers.generated.json'), 'utf8')),
);

function verdictFor(citation, precedentNumbers) {
  const [comment] = extractComments(citation);
  return classifyComment(comment, { precedentNumbers });
}

describe('precedent validation runs from the shipped numbers manifest alone', () => {
  test('the manifest is a non-empty set of positive slot numbers', () => {
    expect(manifest.size).toBeGreaterThan(0);
    for (const slot of manifest) {
      expect(Number.isInteger(slot)).toBe(true);
      expect(slot).toBeGreaterThan(0);
    }
  });

  test('a real citation is admitted and a fabricated one is rejected', () => {
    const [real] = extractComments('// The alignment here follows precedent #42.');
    expect(classifyComment(real, { precedentNumbers: manifest }).allowed).toBe(true);

    const [fake] = extractComments('// Long design rationale, see precedent #999');
    const verdict = classifyComment(fake, { precedentNumbers: manifest });
    expect(verdict.allowed).toBe(false);
    expect(verdict.class).toBe('invalid-precedent');
  });

  const precedentsPath = join(MODULE_DIR, '..', '..', 'PRECEDENTS.md');

  test.skipIf(!existsSync(precedentsPath))(
    'the manifest is regenerated whenever PRECEDENTS.md changes',
    () => {
      const live = parsePrecedentNumbers(readFileSync(precedentsPath, 'utf8'));

      expect([...manifest].sort((a, b) => a - b)).toStrictEqual([...live].sort((a, b) => a - b));
    },
  );

  test('a caller that skips loading a registry fails loud instead of admitting citations', () => {
    const [comment] = extractComments('// as in precedent #7');
    expect(() => classifyComment(comment, {})).toThrow(/precedentNumbers/);
  });
});

describe('a repo root the shipped manifest does not describe', () => {
  const foreignRoot = mkdtempSync(join(tmpdir(), 'no-comments-foreign-root-'));
  const slotThisTreeIssued = Math.min(...manifest);
  const slotThisTreeNeverIssued = Math.max(...manifest) + 45;

  afterAll(() => {
    rmSync(foreignRoot, { recursive: true, force: true });
  });

  test('is a scratch tree with no PRECEDENTS.md, the shape the codemod --root flag is pointed at', () => {
    expect(existsSync(join(foreignRoot, 'PRECEDENTS.md'))).toBe(false);
    expect(foreignRoot).not.toBe(MANIFEST_SUBJECT_ROOT);
    expect(manifest.has(slotThisTreeIssued)).toBe(true);
    expect(manifest.has(slotThisTreeNeverIssued)).toBe(false);
  });

  test('loads a registry that validates nothing rather than borrowing this tree numbers', () => {
    const registry = loadPrecedentNumbers(foreignRoot);
    expect(registry).toBeInstanceOf(UnvalidatedPrecedentRegistry);
    expect([...registry]).toStrictEqual([]);
  });

  test('admits a citation this tree never issued instead of marking it invalid for deletion', () => {
    const verdict = verdictFor(
      `// per precedent #${slotThisTreeNeverIssued}`,
      loadPrecedentNumbers(foreignRoot),
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.class).toBe('precedent-citation');
  });

  test('reaches that verdict for every citation, so no verdict turns on this tree numbering', () => {
    const registry = loadPrecedentNumbers(foreignRoot);
    const shape = (slot) => {
      const verdict = verdictFor(`// per precedent #${slot}`, registry);
      return { allowed: verdict.allowed, class: verdict.class };
    };

    expect(shape(slotThisTreeNeverIssued)).toStrictEqual(shape(slotThisTreeIssued));
  });

  test('the root the manifest does describe still rejects a fabricated citation', () => {
    const registry = loadPrecedentNumbers(MANIFEST_SUBJECT_ROOT);
    expect(registry).not.toBeInstanceOf(UnvalidatedPrecedentRegistry);

    const verdict = verdictFor(`// per precedent #${slotThisTreeNeverIssued}`, registry);
    expect(verdict.allowed).toBe(false);
    expect(verdict.class).toBe('invalid-precedent');
  });
});
