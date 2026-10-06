import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { toWikiLinkSlug } from './slug.ts';
import {
  compareSpellings,
  dependencySlug,
  identityKey,
  leafKey,
  TARGET_IDENTITY,
  type TargetKind,
  wikiAssetPathKey,
} from './target-identity.ts';

const RENE_NFC = 'René';
const RENE_NFD = 'René';
const CAFE_NFC = 'Café';
const CAFE_NFD = 'Café';
const VIET_NFC = 'Việt';
const VIET_PARTIAL = 'Việt';

const KINDS: readonly TargetKind[] = ['document', 'folder', 'file'];

const SPELLING_TOKENS = [
  'a',
  'A',
  'e',
  'E',
  '0',
  '-',
  ' ',
  '/',
  '.',
  'é',
  'é',
  'É',
  'É',
  'ö',
  'ö',
  'ß',
  'ſ',
  'K',
  'K',
  'Å',
  'Å',
  'Å',
  'ﬁ',
  'fi',
  'Σ',
  'σ',
  'ς',
  'İ',
  'ı',
  'i',
  'I',
  'ệ',
  'ệ',
  'ệ',
  '́',
  '日',
  '🙂',
];

type Respelling = 'same' | 'nfc' | 'nfd' | 'upper' | 'lower' | 'swapcase';

function respell(spelling: string, how: Respelling): string {
  switch (how) {
    case 'same':
      return spelling;
    case 'nfc':
      return spelling.normalize('NFC');
    case 'nfd':
      return spelling.normalize('NFD');
    case 'upper':
      return spelling.toUpperCase();
    case 'lower':
      return spelling.toLowerCase();
    case 'swapcase':
      return Array.from(spelling, (character) => {
        const upper = character.toUpperCase();
        return upper === character ? character.toLowerCase() : upper;
      }).join('');
  }
}

const spellingArb = fc.string({ unit: fc.constantFrom(...SPELLING_TOKENS), maxLength: 12 });
const graphemeArb = fc.string({ unit: 'grapheme', maxLength: 12 });
const respellingArb = fc.constantFrom<Respelling>(
  'same',
  'nfc',
  'nfd',
  'upper',
  'lower',
  'swapcase',
);

describe('TARGET_IDENTITY', () => {
  test('documents and folders compare case-sensitively, files case-insensitively, all under NFC', () => {
    expect(TARGET_IDENTITY).toEqual({
      document: { unicode: 'NFC', case: 'sensitive' },
      folder: { unicode: 'NFC', case: 'sensitive' },
      file: { unicode: 'NFC', case: 'insensitive' },
    });
  });
});

describe('leafKey', () => {
  test('folds canonically equivalent spellings onto NFC for every kind', () => {
    for (const kind of KINDS) {
      expect(leafKey(kind, RENE_NFD)).toBe(leafKey(kind, RENE_NFC));
      expect(leafKey(kind, VIET_PARTIAL)).toBe(leafKey(kind, VIET_NFC));
    }
  });

  test('keeps case for documents and folders and drops it for files', () => {
    expect(leafKey('document', 'README')).not.toBe(leafKey('document', 'readme'));
    expect(leafKey('folder', 'Assets')).not.toBe(leafKey('folder', 'assets'));
    expect(leafKey('file', `${CAFE_NFD}.PNG`)).toBe(`${CAFE_NFC.toLowerCase()}.png`);
  });

  test('never folds compatibility lookalikes', () => {
    for (const kind of KINDS) {
      expect(leafKey(kind, 'ﬁle')).not.toBe(leafKey(kind, 'file'));
    }
  });
});

describe('identityKey', () => {
  test('applies the folder rule to ancestors and the kind rule to the leaf', () => {
    expect(identityKey('file', `assets/${CAFE_NFD}.PNG`)).toBe(
      identityKey('file', `assets/${CAFE_NFC}.png`),
    );
    expect(identityKey('file', `Assets/${CAFE_NFC}.png`)).not.toBe(
      identityKey('file', `assets/${CAFE_NFC}.png`),
    );
    expect(identityKey('document', `People/${RENE_NFD}`)).toBe(
      identityKey('document', `People/${RENE_NFC}`),
    );
    expect(identityKey('document', 'Notes/readme')).not.toBe(
      identityKey('document', 'Notes/README'),
    );
  });

  test('the file key is the coarsest key', () => {
    fc.assert(
      fc.property(spellingArb, respellingArb, (spelling, how) => {
        const other = respell(spelling, how);
        for (const kind of ['document', 'folder'] as const) {
          if (identityKey(kind, spelling) === identityKey(kind, other)) {
            expect(identityKey('file', spelling)).toBe(identityKey('file', other));
          }
        }
      }),
    );
  });
});

describe('wikiAssetPathKey', () => {
  test('folds the whole path, ancestors included, under the file rule', () => {
    expect(wikiAssetPathKey(`Assets/${CAFE_NFD}.PNG`)).toBe(
      wikiAssetPathKey(`assets/${CAFE_NFC}.png`),
    );
    expect(identityKey('file', 'Assets/a.png')).not.toBe(identityKey('file', 'assets/a.png'));
    expect(wikiAssetPathKey('Assets/a.png')).toBe(wikiAssetPathKey('assets/a.png'));
    expect(wikiAssetPathKey('ﬁle.png')).not.toBe(wikiAssetPathKey('file.png'));
  });
});

describe('compareSpellings', () => {
  test('orders spellings by UTF-16 code unit', () => {
    expect(compareSpellings('Z', 'a')).toBeLessThan(0);
    expect(compareSpellings('a', 'a')).toBe(0);
    expect(compareSpellings('\u{1F600}', '\uFF21')).toBeLessThan(0);
    expect(['b', 'B', CAFE_NFD, CAFE_NFC].sort(compareSpellings)).toEqual(
      ['B', 'b', CAFE_NFD, CAFE_NFC].sort(),
    );
  });
});

describe('dependencySlug', () => {
  test('agrees across canonically equivalent spellings', () => {
    expect(dependencySlug(`People/${RENE_NFD}`)).toBe(dependencySlug(`People/${RENE_NFC}`));
  });

  test('falls back to the file identity key when the wiki slug is empty', () => {
    expect(toWikiLinkSlug('🙂')).toBe('');
    expect(dependencySlug('🙂')).toBe(identityKey('file', '🙂'));
    expect(dependencySlug('¿?')).toBe(dependencySlug('¿?'.normalize('NFD')));
  });

  test('case variants whose compatibility forms lowercase by context share a dependency slug', () => {
    for (const [a, b] of [
      ['ϲ', 'Ϲ'],
      ['xϲ', 'XϹ'],
      ['ϲ.png', 'Ϲ.PNG'],
    ]) {
      expect(identityKey('file', a)).toBe(identityKey('file', b));
      expect(dependencySlug(a)).toBe(dependencySlug(b));
    }
  });

  test('identity-equal spellings always share a dependency slug (token alphabet)', () => {
    fc.assert(
      fc.property(spellingArb, respellingArb, (spelling, how) => {
        const other = respell(spelling, how);
        for (const kind of KINDS) {
          if (identityKey(kind, spelling) === identityKey(kind, other)) {
            expect(dependencySlug(spelling)).toBe(dependencySlug(other));
          }
        }
      }),
      { numRuns: 2000 },
    );
  });

  test('identity-equal spellings always share a dependency slug (arbitrary graphemes)', () => {
    fc.assert(
      fc.property(graphemeArb, respellingArb, (spelling, how) => {
        const other = respell(spelling, how);
        for (const kind of KINDS) {
          if (identityKey(kind, spelling) === identityKey(kind, other)) {
            expect(dependencySlug(spelling)).toBe(dependencySlug(other));
          }
        }
      }),
      { numRuns: 2000 },
    );
  });
});
