import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  addDocumentFolders,
  asTargetNamespace,
  createTargetNamespace,
  isTargetNamespace,
  type MutableTargetNamespace,
  resolveName,
  type TargetMatch,
  type TargetNamespace,
} from './target-namespace.ts';

const RENE_NFC = 'People/René';
const RENE_NFD = 'People/René';
const ZOE_NFC = 'People/Zoë';
const ZOE_NFD = 'People/Zoë';
const CAFE_NFC = 'assets/Café.png';
const CAFE_NFD = 'assets/Café.png';
const VIET_NFC = 'Việt';
const VIET_NFD = 'Việt';
const VIET_PARTIAL = 'Việt';

describe('createTargetNamespace', () => {
  test('an NFC markdown spelling names the NFD document on disk, and vice versa', () => {
    const nfdOnly = createTargetNamespace('document', [RENE_NFD, 'People/Zoë']);
    expect(nfdOnly.resolve(RENE_NFC)).toBe(RENE_NFD);
    expect(nfdOnly.lookup(RENE_NFC)).toEqual<TargetMatch>({ kind: 'equivalent', name: RENE_NFD });
    expect(nfdOnly.resolve(ZOE_NFD)).toBe(ZOE_NFC);
    expect(nfdOnly.resolve('People/Nope')).toBeUndefined();
    expect(nfdOnly.lookup('People/Nope')).toEqual<TargetMatch>({ kind: 'absent' });
  });

  test('an exact spelling always beats an equivalent one', () => {
    const twins = createTargetNamespace('document', [RENE_NFC, RENE_NFD]);
    expect(twins.resolve(RENE_NFC)).toBe(RENE_NFC);
    expect(twins.resolve(RENE_NFD)).toBe(RENE_NFD);
    expect(twins.lookup(RENE_NFC)).toEqual<TargetMatch>({ kind: 'exact', name: RENE_NFC });
    expect(twins.lookup(RENE_NFD)).toEqual<TargetMatch>({ kind: 'exact', name: RENE_NFD });
  });

  test('a third spelling of two twins is ambiguous, still exists, and picks the lowest code points', () => {
    const twins = createTargetNamespace('document', [VIET_NFC, VIET_NFD]);
    expect(twins.lookup(VIET_PARTIAL)).toEqual<TargetMatch>({
      kind: 'ambiguous',
      name: VIET_NFD,
      candidates: [VIET_NFD, VIET_NFC],
    });
    expect(twins.resolve(VIET_PARTIAL)).toBe(VIET_NFD);
  });

  test('add and delete are idempotent and keep resolution in step with membership', () => {
    const names = createTargetNamespace('document', []);
    expect(names.add(RENE_NFC)).toBe(names);
    expect(names.add(RENE_NFC).add(RENE_NFD).size).toBe(2);
    expect(names.delete(RENE_NFC)).toBe(true);
    expect(names.delete(RENE_NFC)).toBe(false);
    expect(names.resolve(RENE_NFC)).toBe(RENE_NFD);
    expect(names.delete(RENE_NFD)).toBe(true);
    expect(names.resolve(RENE_NFC)).toBeUndefined();
    expect(names.size).toBe(0);
    names.add(RENE_NFD);
    names.clear();
    expect(names.resolve(RENE_NFC)).toBeUndefined();
    expect(names.lookup(RENE_NFD)).toEqual<TargetMatch>({ kind: 'absent' });
  });

  test('a compatibility lookalike never matches', () => {
    const names = createTargetNamespace('document', ['file']);
    expect(names.resolve('ﬁle')).toBeUndefined();
    expect(createTargetNamespace('file', ['ﬁle.txt']).resolve('file.txt')).toBeUndefined();
  });

  test('files ignore leaf case but keep ancestor folder case; documents keep case', () => {
    const files = createTargetNamespace('file', [CAFE_NFD]);
    expect(files.resolve('assets/CAFÉ.PNG')).toBe(CAFE_NFD);
    expect(files.resolve(CAFE_NFC)).toBe(CAFE_NFD);
    expect(files.resolve('Assets/Café.png')).toBeUndefined();
    const documents = createTargetNamespace('document', ['Notes/README']);
    expect(documents.resolve('Notes/readme')).toBeUndefined();
    expect(createTargetNamespace('folder', ['Assets']).resolve('assets')).toBeUndefined();
  });

  test('is a ReadonlySet of the raw names with exact membership', () => {
    const names: ReadonlySet<string> = createTargetNamespace('document', [RENE_NFD]);
    expect(names.has(RENE_NFD)).toBe(true);
    expect(names.has(RENE_NFC)).toBe(false);
    expect(names.size).toBe(1);
    expect([...names]).toEqual([RENE_NFD]);
    expect([...names.keys()]).toEqual([RENE_NFD]);
    expect([...names.values()]).toEqual([RENE_NFD]);
    expect([...names.entries()]).toEqual([[RENE_NFD, RENE_NFD]]);
    const seen: string[] = [];
    names.forEach((value, again, set) => {
      seen.push(value, again);
      expect(set).toBe(names);
    });
    expect(seen).toEqual([RENE_NFD, RENE_NFD]);
    expect(new Set(names)).toEqual(new Set([RENE_NFD]));
  });
});

describe('resolveName', () => {
  test('resolves through a namespace and exactly through a plain set', () => {
    const namespace = createTargetNamespace('document', [RENE_NFD]);
    const plain = new Set([RENE_NFD]);
    expect(isTargetNamespace(namespace)).toBe(true);
    expect(isTargetNamespace(plain)).toBe(false);
    expect(resolveName(namespace, RENE_NFC)).toBe(RENE_NFD);
    expect(resolveName(plain, RENE_NFC)).toBeUndefined();
    expect(resolveName(plain, RENE_NFD)).toBe(RENE_NFD);
    expect(resolveName(namespace, 'People/Nope')).toBeUndefined();
  });
});

describe('addDocumentFolders', () => {
  test('adds every ancestor folder of every document and keeps folders already present', () => {
    const folders = addDocumentFolders(createTargetNamespace('folder', ['empty']), [
      'root',
      'a/b/c',
      'a/d',
      `${RENE_NFD}/notes`,
    ]);
    expect([...folders].sort()).toEqual(['a', 'a/b', 'empty', RENE_NFD, 'People'].sort());
    expect(folders.resolve(RENE_NFC)).toBe(RENE_NFD);
    expect(folders.resolve('A')).toBeUndefined();
  });
});

describe('asTargetNamespace', () => {
  test('reuses a namespace of the same kind and indexes anything else', () => {
    const documents = createTargetNamespace('document', [RENE_NFD]);
    expect(asTargetNamespace('document', documents)).toBe(documents);
    const rebuilt = asTargetNamespace('file', documents);
    expect(rebuilt).not.toBe(documents);
    expect(rebuilt.kind).toBe('file');
    expect(rebuilt.resolve('People/RENÉ')).toBe(RENE_NFD);
    expect(documents.resolve('People/RENÉ')).toBeUndefined();
    const fromArray = asTargetNamespace('document', [RENE_NFD]);
    expect(fromArray.resolve(RENE_NFC)).toBe(RENE_NFD);
  });
});

const NAME_ALPHABET = [
  RENE_NFC,
  RENE_NFD,
  RENE_NFC.toLowerCase(),
  ZOE_NFC,
  ZOE_NFD,
  CAFE_NFC,
  CAFE_NFD,
  'assets/CAFÉ.PNG',
  VIET_NFC,
  VIET_NFD,
  VIET_PARTIAL,
  'README',
  'readme',
  'a/b',
  'a-b',
];

type Step = { readonly op: 'add' | 'delete'; readonly name: string };

function describeNamespace(names: TargetNamespace<'document' | 'file'>): string {
  return NAME_ALPHABET.map((spelling) => JSON.stringify(names.lookup(spelling))).join('\n');
}

describe('insertion-order independence', () => {
  test('every permutation of the same names resolves every spelling identically', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...NAME_ALPHABET), { maxLength: 8 }),
        fc.constantFrom('document', 'file'),
        (names, kind) => {
          const sorted = createTargetNamespace(kind, [...names].sort());
          const reversed = createTargetNamespace(kind, [...names].sort().reverse());
          expect(describeNamespace(reversed)).toBe(describeNamespace(sorted));
        },
      ),
    );
  });

  test('a namespace mutated by random adds and deletes equals a fresh one over the final set', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record<Step>({
            op: fc.constantFrom('add', 'delete'),
            name: fc.constantFrom(...NAME_ALPHABET),
          }),
          { maxLength: 24 },
        ),
        fc.constantFrom('document', 'file'),
        (steps, kind) => {
          const incremental: MutableTargetNamespace<'document' | 'file'> = createTargetNamespace(
            kind,
            [],
          );
          const expected = new Set<string>();
          for (const step of steps) {
            if (step.op === 'add') {
              incremental.add(step.name);
              expected.add(step.name);
            } else {
              expect(incremental.delete(step.name)).toBe(expected.has(step.name));
              expected.delete(step.name);
            }
          }
          const fresh = createTargetNamespace(kind, expected);
          expect(new Set(incremental)).toEqual(expected);
          expect(describeNamespace(incremental)).toBe(describeNamespace(fresh));
        },
      ),
    );
  });
});
