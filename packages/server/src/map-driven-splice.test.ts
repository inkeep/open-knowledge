import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import { describe, expect, test } from 'vitest';
import { computeMapDrivenBodySplice } from './map-driven-splice.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });

function applySplice(
  oldBody: string,
  splice: { spliceStart: number; spliceEnd: number; newSlice: string },
): string {
  return oldBody.slice(0, splice.spliceStart) + splice.newSlice + oldBody.slice(splice.spliceEnd);
}

function pmFromMd(md: string): JSONContent {
  return mdManager.parse(md);
}

describe('computeMapDrivenBodySplice', () => {
  describe('byte preservation outside the splice', () => {
    test('single-block edit produces splice covering only the edited block', () => {
      const oldBody = '# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n';
      const newBody = '# Heading\n\nFirst paragraph EDITED.\n\nSecond paragraph.\n';

      const splice = computeMapDrivenBodySplice(oldBody, pmFromMd(newBody), mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const headingEnd = oldBody.indexOf('# Heading') + '# Heading'.length;
      expect(splice.spliceStart).toBeGreaterThanOrEqual(headingEnd);
      const secondParaStart = oldBody.indexOf('Second paragraph');
      expect(splice.spliceEnd).toBeLessThanOrEqual(secondParaStart);

      expect(oldBody.slice(0, splice.spliceStart)).toBe(
        applySplice(oldBody, splice).slice(0, splice.spliceStart),
      );
      const reconstructed = applySplice(oldBody, splice);
      expect(reconstructed.slice(splice.spliceStart + splice.newSlice.length)).toBe(
        oldBody.slice(splice.spliceEnd),
      );
    });

    test('result of applying splice equals the canonical newBody serialization', () => {
      const oldBody = '# Heading\n\nFirst.\n\nSecond.\n';
      const newPm = pmFromMd('# Heading\n\nFirst CHANGED.\n\nSecond.\n');
      const splice = computeMapDrivenBodySplice(oldBody, newPm, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const reconstructed = applySplice(oldBody, splice);
      const canonicalNew = mdManager.serialize(newPm);
      const reconstructedMdast = mdManager.parseToMdast(reconstructed);
      const canonicalMdast = mdManager.parseToMdast(canonicalNew);
      expect(reconstructedMdast.children.length).toBe(canonicalMdast.children.length);
    });
  });

  describe('source-form preservation through structural equality', () => {
    test('an untouched block whose canonical form would canonicalize bytes is excluded from splice', () => {
      const oldBody = '*italic one*\n\nuntouched two\n';
      const newPmJson = pmFromMd('*italic one* EDIT\n\nuntouched two\n');
      const splice = computeMapDrivenBodySplice(oldBody, newPmJson, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const result = applySplice(oldBody, splice);
      expect(result).toContain('untouched two');
      const oldUntouched = oldBody.slice(oldBody.indexOf('untouched two'));
      const newUntouched = result.slice(result.indexOf('untouched two'));
      expect(newUntouched).toBe(oldUntouched);
    });

    test('block matching the structural shape but canonicalized in newBody is NOT spliced', () => {
      const oldBody = '*italic*\n\nplain\n';
      const newPmJson = pmFromMd('*italic*\n\nplain CHANGED\n');
      const splice = computeMapDrivenBodySplice(oldBody, newPmJson, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const result = applySplice(oldBody, splice);
      expect(result.startsWith('*italic*\n\n')).toBe(true);
    });
  });

  describe('insertions and deletions at boundaries', () => {
    test('append a new paragraph at end', () => {
      const oldBody = 'First.\n';
      const newPmJson = pmFromMd('First.\n\nSecond.\n');
      const splice = computeMapDrivenBodySplice(oldBody, newPmJson, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const result = applySplice(oldBody, splice);
      expect(result).toContain('First.');
      expect(result).toContain('Second.');
      expect(result.indexOf('First.')).toBe(0);
    });

    test('prepend a new paragraph at start', () => {
      const oldBody = 'Second.\n';
      const newPmJson = pmFromMd('First.\n\nSecond.\n');
      const splice = computeMapDrivenBodySplice(oldBody, newPmJson, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const result = applySplice(oldBody, splice);
      expect(result).toContain('First.');
      expect(result).toContain('Second.');
      expect(result.indexOf('First.')).toBeLessThan(result.indexOf('Second.'));
    });

    test('insert a paragraph in the middle preserves surrounding blocks byte-identically', () => {
      const oldBody = '*Pre*\n\nPost.\n';
      const newPmJson = pmFromMd('*Pre*\n\nMiddle.\n\nPost.\n');
      const splice = computeMapDrivenBodySplice(oldBody, newPmJson, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const result = applySplice(oldBody, splice);
      expect(result.startsWith('*Pre*')).toBe(true);
      expect(result).toContain('Middle.');
      expect(result.endsWith('Post.\n')).toBe(true);
    });

    test('delete a middle block', () => {
      const oldBody = 'A.\n\nB.\n\nC.\n';
      const newPmJson = pmFromMd('A.\n\nC.\n');
      const splice = computeMapDrivenBodySplice(oldBody, newPmJson, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const result = applySplice(oldBody, splice);
      expect(result).toContain('A.');
      expect(result).toContain('C.');
      expect(result).not.toContain('B.');
    });
  });

  describe('synthetic / empty inputs', () => {
    test('empty oldBody + new content produces splice that yields the new content', () => {
      const oldBody = '';
      const newPmJson = pmFromMd('A new paragraph.\n');
      const splice = computeMapDrivenBodySplice(oldBody, newPmJson, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const result = applySplice(oldBody, splice);
      expect(result).toContain('A new paragraph.');
    });

    test('no-change input produces no-op splice', () => {
      const oldBody = 'A.\n\nB.\n';
      const newPmJson = pmFromMd(oldBody);
      const splice = computeMapDrivenBodySplice(oldBody, newPmJson, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const result = applySplice(oldBody, splice);
      const oldChildren = mdManager.parseToMdast(oldBody).children;
      const resultChildren = mdManager.parseToMdast(result).children;
      expect(resultChildren.length).toBe(oldChildren.length);
    });
  });

  describe('contiguous multi-block edits', () => {
    test('editing two adjacent blocks unions their splice ranges', () => {
      const oldBody = 'first.\n\nsecond.\n\nthird.\n';
      const newPmJson = pmFromMd('first EDITED.\n\nsecond EDITED.\n\nthird.\n');
      const splice = computeMapDrivenBodySplice(oldBody, newPmJson, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const result = applySplice(oldBody, splice);
      expect(result.endsWith('third.\n')).toBe(true);

      const thirdStartOld = oldBody.indexOf('third.');
      expect(splice.spliceEnd).toBeLessThanOrEqual(thirdStartOld);
    });

    test('non-contiguous multi-block edits collapse into one over-wide splice (documented AC2 degradation)', () => {
      const oldBody = 'first.\n\nmiddle.\n\nthird.\n';
      const newPmJson = pmFromMd('first EDITED.\n\nmiddle.\n\nthird EDITED.\n');
      const splice = computeMapDrivenBodySplice(oldBody, newPmJson, mdManager);
      expect(splice).not.toBeNull();
      if (!splice) return;

      const middleStart = oldBody.indexOf('middle.');
      expect(splice.spliceStart).toBeLessThanOrEqual(middleStart);
      expect(splice.spliceEnd).toBeGreaterThanOrEqual(middleStart + 'middle.'.length);

      const result = applySplice(oldBody, splice);
      expect(result).toContain('first EDITED.');
      expect(result).toContain('middle.');
      expect(result).toContain('third EDITED.');
    });
  });

  describe('robustness to parse failure', () => {
    test('returns null when serialize throws on schema-rejected JSON', () => {
      const oldBody = 'A.\n';
      const malformed = { type: 'not-a-real-node-type' } as JSONContent;
      const splice = computeMapDrivenBodySplice(oldBody, malformed, mdManager);
      expect(splice).toBeNull();
    });
  });
});
