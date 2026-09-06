import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import { describe, expect, test } from 'vitest';
import {
  computeMapDrivenBodySplice,
  createEditorMdastMemo,
  type EditorMdastMemo,
} from './map-driven-splice.ts';
import type { MapDrivenSpliceMemoSkipReason } from './metrics.ts';
import { createCountingManager } from './parse-counting.test-helper.ts';

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

describe('editor-mdast parse memo (PRD-8273)', () => {
  test('a repeated body is parsed once, not once per call', () => {
    const { manager: counted, parses } = createCountingManager();
    const memo = createEditorMdastMemo();
    const bodyA = '# H\n\nalpha\n';

    const first = computeMapDrivenBodySplice(bodyA, counted.parse('# H\n\nalphaX\n'), counted, {
      memo,
    });
    expect(first).not.toBeNull();
    if (!first) return;
    const bodyB = applySplice(bodyA, first);
    const afterFirst = parses();

    computeMapDrivenBodySplice(bodyB, counted.parse('# H\n\nalphaXY\n'), counted, { memo });

    expect(parses() - afterFirst).toBe(1);
  });

  test('a body changed out from under the memo misses rather than serving a stale parse', () => {
    const { manager: counted, parses } = createCountingManager();
    const memo = createEditorMdastMemo();

    const primed = '# H\n\nalpha\n';
    computeMapDrivenBodySplice(primed, counted.parse('# H\n\nalphaX\n'), counted, { memo });
    const afterPrime = parses();

    const external = '# DIFFERENT\n\nomega\n\ntail\n';
    const splice = computeMapDrivenBodySplice(
      external,
      counted.parse('# DIFFERENT\n\nomega EDITED\n\ntail\n'),
      counted,
      { memo },
    );
    expect(splice).not.toBeNull();
    if (!splice) return;

    expect(parses() - afterPrime).toBe(2);

    const result = applySplice(external, splice);
    expect(result).toContain('omega EDITED');
    expect(result).toContain('# DIFFERENT');
    expect(result.endsWith('tail\n')).toBe(true);
  });

  test('a splice built from a memo hit equals one built from a fresh parse', () => {
    const { manager: counted, parses } = createCountingManager();
    const memo = createEditorMdastMemo();
    const bodyA = '# H\n\none\n\ntwo\n\nthree\n';

    const first = computeMapDrivenBodySplice(
      bodyA,
      counted.parse('# H\n\none EDITED\n\ntwo\n\nthree\n'),
      counted,
      { memo },
    );
    expect(first).not.toBeNull();
    if (!first) return;
    const bodyB = applySplice(bodyA, first);

    const newPm = counted.parse('# H\n\none EDITED\n\ntwo CHANGED\n\nthree\n');
    const before = parses();
    const fromHit = computeMapDrivenBodySplice(bodyB, newPm, counted, { memo });
    expect(parses() - before).toBe(1);

    const fromFreshParse = computeMapDrivenBodySplice(bodyB, newPm, counted);
    expect(fromHit).toEqual(fromFreshParse);
    expect(fromHit).not.toBeNull();
  });

  test('preserved bytes the serializer would not emit still hit the next drain', () => {
    const { manager: counted, parses } = createCountingManager();
    const memo = createEditorMdastMemo();
    const bodyA = 'one   \n\ntwo\n\nthree\n';

    const first = computeMapDrivenBodySplice(
      bodyA,
      counted.parse('one   \n\ntwo A\n\nthree\n'),
      counted,
      { memo },
    );
    expect(first).not.toBeNull();
    if (!first) return;
    const bodyB = applySplice(bodyA, first);
    expect(bodyB).not.toBe(counted.serialize(counted.parse(bodyB)));
    expect(memo.entry?.body).toBe(bodyB);

    const newPm = counted.parse('one   \n\ntwo B\n\nthree\n');
    const before = parses();
    const fromHit = computeMapDrivenBodySplice(bodyB, newPm, counted, { memo });
    expect(parses() - before).toBe(1);
    expect(fromHit).toEqual(computeMapDrivenBodySplice(bodyB, newPm, counted));
  });

  test('a same-length body with different content misses — the key is bytes, not length', () => {
    const { manager: counted, parses } = createCountingManager();
    const memo = createEditorMdastMemo();

    const primed = counted.serialize(counted.parse('one\n\ntwo\n\nthree\n'));
    const actual = 'one two\n\nthreeX\n';
    expect(actual.length).toBe(primed.length);
    expect(actual).not.toBe(primed);

    computeMapDrivenBodySplice('zzz\n', counted.parse(primed), counted, { memo });

    const newPm = counted.parse('one two\n\nthreeY\n');
    const before = parses();
    const withMemo = computeMapDrivenBodySplice(actual, newPm, counted, { memo });
    expect(parses() - before).toBe(2);

    const withoutMemo = computeMapDrivenBodySplice(actual, newPm, counted);
    expect(withMemo).toEqual(withoutMemo);
    expect(withMemo).not.toBeNull();
  });
});

describe('caller-supplied serialization', () => {
  test('a body serialized from the same PM JSON is reused instead of re-serialized', () => {
    const { manager: counted, serializes } = createCountingManager();
    const memo = createEditorMdastMemo();
    const oldBody = '# H\n\none\n\ntwo\n';
    const newPm = counted.parse('# H\n\none EDITED\n\ntwo\n');
    const body = counted.serialize(newPm);

    const before = serializes();
    const reused = computeMapDrivenBodySplice(oldBody, newPm, counted, {
      memo,
      serializedNewPm: { json: newPm, body, opts: undefined },
    });
    expect(serializes() - before).toBe(0);
    expect(reused).toEqual(computeMapDrivenBodySplice(oldBody, newPm, counted));
  });

  test('a body carried from different PM JSON is ignored and the splice serializes itself', () => {
    const { manager: counted, serializes } = createCountingManager();
    const oldBody = '# H\n\none\n\ntwo\n';
    const newPm = counted.parse('# H\n\none EDITED\n\ntwo\n');
    const stale = counted.parse('# H\n\nSTALE\n\ntwo\n');
    const staleBody = counted.serialize(stale);

    const before = serializes();
    const splice = computeMapDrivenBodySplice(oldBody, newPm, counted, {
      serializedNewPm: { json: stale, body: staleBody, opts: undefined },
    });
    const selfSerializes = serializes() - before;
    expect(selfSerializes).toBe(1);
    expect(splice).toEqual(computeMapDrivenBodySplice(oldBody, newPm, counted));
  });
});

describe('spliced-body memo fidelity', () => {
  const DIRTY_PREFIX = 'preserved   \n\n';

  const NARROWABLE_SHAPES = new Set(['list', 'blockquote', 'loose-list']);

  const CORPUS: Array<[string, string]> = [
    ['paragraphs', 'one\n\ntwo\n\nthree\n\nfour\n'],
    ['headings', '# H\n\npara\n\n## H2\n\npara two\n\ntail\n'],
    ['list', '# H\n\n- one\n- two\n- three\n\npara\n\ntail\n'],
    ['blockquote', '# H\n\n> one\n>\n> two\n\npara\n\ntail\n'],
    ['table', '# H\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\npara\n\ntail\n'],
    ['code-fence', '# H\n\n```js\nconst a = 1;\n```\n\npara\n\ntail\n'],
    ['setext', 'Title\n=====\n\npara\n\ntail\n'],
    ['definitions', '# H\n\n[a]: http://example.com\n\nsee [a]\n\npara two\n\ntail\n'],
    ['footnote', '# H\n\ntext[^1]\n\n[^1]: note\n\npara two\n\ntail\n'],
    ['dirty-bytes', 'one   \n\ntwo\n\nthree\n\nfour\n'],
    ['blank-runs', 'one\n\n\n\ntwo\n\nthree\n\nfour\n'],
    ['thematic-break', 'one\n\n---\n\ntwo\n\nthree\n'],
    ['loose-list', '# H\n\n- one\n\n- two\n\npara\n\ntail\n'],
    [
      'many-blocks',
      `${Array.from({ length: 60 }, (_, i) => `Paragraph ${i} body text.`).join('\n\n')}\n`,
    ],
  ];

  const EDITS: Array<[string, (text: string) => string]> = [
    ['append-char', (text) => `${text}Z`],
    ['prepend-char', (text) => `Z${text}`],
    ['emphasis-marker', (text) => `${text} *em*`],
    ['dash-run', (text) => `${text} ---`],
  ];

  function editFirstLeaf(
    json: JSONContent,
    blockIndex: number,
    edit: (text: string) => string,
  ): JSONContent | null {
    const clone = structuredClone(json) as JSONContent;
    const block = clone.content?.[blockIndex];
    if (!block) return null;
    const stack: JSONContent[] = [block];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      if (typeof node.text === 'string') {
        node.text = edit(node.text);
        return clone;
      }
      for (const child of node.content ?? []) stack.push(child);
    }
    return null;
  }

  function appendToFirstLeaf(json: JSONContent, blockIndex: number): JSONContent | null {
    return editFirstLeaf(json, blockIndex, (text) => `${text}Z`);
  }

  for (const [label, canonicalDoc] of CORPUS) {
    for (const [form, doc] of [
      ['canonical', canonicalDoc],
      ['non-canonical', `${DIRTY_PREFIX}${canonicalDoc}`],
    ] as const) {
      test(`${label} (${form}): every composed entry equals a fresh parse of the spliced body`, () => {
        const pm = mdManager.parse(doc);
        const blockCount = pm.content?.length ?? 0;
        expect(blockCount).toBeGreaterThan(0);
        const firstEditable = form === 'canonical' ? 0 : 1;
        let composed = 0;
        let attempted = 0;
        const skips: MapDrivenSpliceMemoSkipReason[] = [];

        for (let index = firstEditable; index < blockCount; index++) {
          for (const [, edit] of EDITS) {
            const edited = editFirstLeaf(pm, index, edit);
            if (!edited) continue;
            attempted++;
            const memo = createEditorMdastMemo();
            const newBody = mdManager.serialize(edited);
            const splice = computeMapDrivenBodySplice(doc, edited, mdManager, {
              memo,
              onMemoSkip: (reason) => skips.push(reason),
            });
            expect(splice).not.toBeNull();
            if (!splice) continue;
            const applied = applySplice(doc, splice);
            expect(memo.entry).not.toBeNull();
            if (applied === newBody) {
              expect(memo.entry?.body).toBe(newBody);
              continue;
            }
            if (memo.entry?.body !== applied) continue;
            composed++;
            expect(JSON.stringify(memo.entry.children)).toBe(
              JSON.stringify(mdManager.parseToEditorMdast(applied).children),
            );
          }
        }

        const narrowedSkips = skips.filter((reason) => reason === 'narrowed').length;
        const alreadyCurrentSkips = skips.filter(
          (reason) => reason === 'entry-already-current',
        ).length;

        expect(attempted).toBeGreaterThan(0);
        expect(skips.filter((r) => r !== 'narrowed' && r !== 'entry-already-current')).toEqual([]);
        expect(composed).toBe(attempted - narrowedSkips - alreadyCurrentSkips);
        if (form === 'canonical') {
          expect(alreadyCurrentSkips).toBeGreaterThan(0);
        } else {
          expect(composed).toBeGreaterThan(0);
        }
        if (NARROWABLE_SHAPES.has(label)) {
          expect(narrowedSkips).toBeGreaterThan(0);
        } else {
          expect(narrowedSkips).toBe(0);
        }
      });
    }
  }

  test('a container-narrowed splice leaves the constructed entry unwritten', () => {
    const doc = 'para   \n\n- one\n- two\n- three\n\ntail\n';
    const pm = mdManager.parse(doc);
    const edited = appendToFirstLeaf(pm, 1);
    expect(edited).not.toBeNull();
    if (!edited) return;
    const memo = createEditorMdastMemo();
    const splice = computeMapDrivenBodySplice(doc, edited, mdManager, { memo });
    expect(splice).not.toBeNull();
    if (!splice) return;
    const applied = applySplice(doc, splice);
    const newBody = mdManager.serialize(edited);
    expect(applied).not.toBe(newBody);
    expect(applied.startsWith('para   ')).toBe(true);
    expect(splice.spliceStart).toBeGreaterThan(doc.indexOf('- one'));
    expect(memo.entry?.body).toBe(newBody);
  });
});

describe('spliced-body memo failure isolation', () => {
  test('a throwing memo write costs the optimization, not the splice', () => {
    const oldBody = 'preserved   \n\none\n\ntwo\n\nthree\n';
    const newPm = mdManager.parse('preserved   \n\none EDITED\n\ntwo\n\nthree\n');
    const reasons: MapDrivenSpliceMemoSkipReason[] = [];
    const errors: unknown[] = [];
    const composeFailure = new Error('synthetic composition regression');
    let stored: EditorMdastMemo['entry'] = null;
    let writes = 0;
    const hostileMemo = {
      get entry() {
        return stored;
      },
      set entry(value: EditorMdastMemo['entry']) {
        writes++;
        if (writes > 2) throw composeFailure;
        stored = value;
      },
    } as EditorMdastMemo;

    const splice = computeMapDrivenBodySplice(oldBody, newPm, mdManager, {
      memo: hostileMemo,
      onMemoSkip: (reason, err) => {
        reasons.push(reason);
        errors.push(err);
      },
    });

    expect(splice).not.toBeNull();
    expect(splice).toEqual(computeMapDrivenBodySplice(oldBody, newPm, mdManager));
    expect(writes).toBe(3);
    expect(reasons).toEqual(['compose-failed']);
    expect(errors).toEqual([composeFailure]);
  });
});
