import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  buildPacket,
  CHROME_SURFACES,
  generate,
  MAX_PER_GLOSSARY_TERM,
  parseArgs,
  parsePoEntries,
  readGlossaryTerms,
  readLocaleTuple,
  readReviewStatus,
  readSection,
  selectMessages,
  TARGET_MESSAGES,
} from './generate-locale-review-packet.mjs';

const OK_ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(OK_ROOT, rel), 'utf8');

const LOCALES_TS = read('packages/core/src/i18n/locales.ts');
const REVIEW_MD = read('packages/app/src/locales/REVIEW.md');
const SOURCE_CATALOG = read('packages/app/src/locales/en/messages.po');

const SUPPORTED = readLocaleTuple(LOCALES_TS, 'SUPPORTED_LOCALES');
const PICKER = readLocaleTuple(LOCALES_TS, 'PICKER_LOCALES');
const LAYOUT_DEFERRED = readLocaleTuple(LOCALES_TS, 'LAYOUT_DEFERRED_LOCALES');

describe('reading the locale tuples', () => {
  test('reads each tuple out of core by name', () => {
    expect(SUPPORTED).toContain('en');
    expect(PICKER.every((locale) => SUPPORTED.includes(locale))).toBe(true);
    expect(LAYOUT_DEFERRED.every((locale) => SUPPORTED.includes(locale))).toBe(true);
  });

  test('refuses a source it cannot find the named tuple in', () => {
    expect(() =>
      readLocaleTuple("export const SUPPORTED_LOCALES = ['en'];", 'PICKER_LOCALES'),
    ).toThrow(/PICKER_LOCALES/);
  });

  test('refuses an empty tuple rather than reporting nothing to promote', () => {
    expect(() =>
      readLocaleTuple('export const PICKER_LOCALES = [] as const;', 'PICKER_LOCALES'),
    ).toThrow(/empty/);
  });
});

describe('parsing the catalog with its source references', () => {
  const catalog = [
    'msgid ""',
    'msgstr ""',
    '"Language: en\\n"',
    '',
    '#: src/components/Alpha.tsx',
    'msgid "Save"',
    'msgstr "Save"',
    '',
    '#. placeholder {0}: name',
    '#: src/components/Alpha.tsx',
    '#: src/components/Beta.tsx',
    'msgid "Delete {0}?"',
    'msgstr "Delete {0}?"',
    '',
  ].join('\n');

  test('keeps the source references a plain catalog parse discards', () => {
    expect(parsePoEntries(catalog)).toEqual([
      { id: 'Save', str: 'Save', references: ['src/components/Alpha.tsx'] },
      {
        id: 'Delete {0}?',
        str: 'Delete {0}?',
        references: ['src/components/Alpha.tsx', 'src/components/Beta.tsx'],
      },
    ]);
  });

  test('drops the header block, which carries metadata rather than a message', () => {
    expect(parsePoEntries(catalog).map((entry) => entry.id)).not.toContain('');
  });

  test('reads a message whose text is wrapped across continuation lines', () => {
    const wrapped = ['#: src/a.tsx', 'msgid ""', '"one "', '"two"', 'msgstr ""', '"uno dos"'].join(
      '\n',
    );
    expect(parsePoEntries(wrapped)).toEqual([
      { id: 'one two', str: 'uno dos', references: ['src/a.tsx'] },
    ]);
  });
});

describe('reading the glossary', () => {
  const glossary = [
    '## The nouns',
    '',
    '| Term | `es` | `fr` |',
    '| --- | --- | --- |',
    '| document | documento | document |',
    '| folder | carpeta | dossier |',
    '',
    '| Term | `hi` |',
    '| --- | --- |',
    '| document | दस्तावेज़ |',
    '',
    '## Never translated',
    '',
    '- **OpenKnowledge** — the product name.',
    '',
    '## Why these forms',
    '',
    'Because.',
  ].join('\n');

  test('finds a locale column by its header rather than its position', () => {
    expect(readGlossaryTerms(glossary, 'fr')).toEqual([
      { term: 'document', translation: 'document' },
      { term: 'folder', translation: 'dossier' },
    ]);
  });

  test('reads a locale that sits in a later table', () => {
    expect(readGlossaryTerms(glossary, 'hi')).toEqual([
      { term: 'document', translation: 'दस्तावेज़' },
    ]);
  });

  test('returns nothing for a locale the glossary has no column for', () => {
    expect(readGlossaryTerms(glossary, 'sv')).toEqual([]);
  });

  test('quotes one section verbatim and stops at the next heading', () => {
    expect(readSection(glossary, 'Never translated')).toBe(
      '- **OpenKnowledge** — the product name.',
    );
  });
});

describe('the selection rule', () => {
  const surfaces = [
    { label: 'Alpha', why: 'first', files: ['src/Alpha.tsx'] },
    { label: 'Beta', why: 'second', files: ['src/Beta.tsx'] },
  ];
  const entry = (id, references) => ({ id, str: id, references });

  test('shows each locked word in context, shortest English first', () => {
    const { glossaryUses } = selectMessages({
      entries: [
        entry('Delete this document permanently?', []),
        entry('New document', []),
        entry('Document', []),
      ],
      translations: new Map(),
      glossaryTerms: [{ term: 'document', translation: 'documento' }],
      surfaces,
      maxPerTerm: 2,
    });
    expect(glossaryUses[0].uses.map((use) => use.id)).toEqual(['Document', 'New document']);
  });

  test('caps how many uses of one locked word it shows', () => {
    const { glossaryUses } = selectMessages({
      entries: Array.from({ length: 20 }, (_, i) => entry(`document ${'x'.repeat(i)}`, [])),
      translations: new Map(),
      glossaryTerms: [{ term: 'document', translation: 'documento' }],
      surfaces,
    });
    expect(glossaryUses[0].uses.length).toBe(MAX_PER_GLOSSARY_TERM);
  });

  test('matches a locked word case-insensitively and in the plural', () => {
    const { glossaryUses } = selectMessages({
      entries: [entry('All folders', []), entry('a FOLDER', [])],
      translations: new Map(),
      glossaryTerms: [{ term: 'folder', translation: 'carpeta' }],
      surfaces,
    });
    expect(glossaryUses[0].uses.map((use) => use.id).sort()).toEqual(['All folders', 'a FOLDER']);
  });

  test("does not match a locked word wearing another word's tail", () => {
    const { glossaryUses } = selectMessages({
      entries: [entry('Branching strategy', []), entry('Rebranch', [])],
      translations: new Map(),
      glossaryTerms: [{ term: 'branch', translation: 'rama' }],
      surfaces,
    });
    expect(glossaryUses[0].uses).toEqual([]);
  });

  test('fills the surfaces round-robin so a large one cannot crowd out a small one', () => {
    const { surfaces: picked } = selectMessages({
      entries: [
        entry('a1', ['src/Alpha.tsx']),
        entry('a2', ['src/Alpha.tsx']),
        entry('a3', ['src/Alpha.tsx']),
        entry('a4', ['src/Alpha.tsx']),
        entry('b1', ['src/Beta.tsx']),
        entry('b2', ['src/Beta.tsx']),
      ],
      translations: new Map(),
      glossaryTerms: [],
      surfaces,
      target: 4,
    });
    expect(picked.map(({ messages }) => messages.map((m) => m.id))).toEqual([
      ['a1', 'a2'],
      ['b1', 'b2'],
    ]);
  });

  test('keeps filling from the surfaces that still have messages once one runs dry', () => {
    const { surfaces: picked } = selectMessages({
      entries: [
        entry('a1', ['src/Alpha.tsx']),
        entry('b1', ['src/Beta.tsx']),
        entry('b2', ['src/Beta.tsx']),
        entry('b3', ['src/Beta.tsx']),
      ],
      translations: new Map(),
      glossaryTerms: [],
      surfaces,
      target: 4,
    });
    expect(picked.map(({ messages }) => messages.length)).toEqual([1, 3]);
  });

  test('does not offer a message twice when two surfaces both reference it', () => {
    const { surfaces: picked } = selectMessages({
      entries: [
        entry('shared', ['src/Alpha.tsx', 'src/Beta.tsx']),
        entry('b-only', ['src/Beta.tsx']),
      ],
      translations: new Map(),
      glossaryTerms: [],
      surfaces,
      target: 10,
    });
    expect(picked.map(({ messages }) => messages.map((m) => m.id))).toEqual([
      ['shared'],
      ['b-only'],
    ]);
  });

  test('does not offer a message twice when a surface also uses a locked word', () => {
    const { glossaryUses, surfaces: picked } = selectMessages({
      entries: [entry('New folder', ['src/Alpha.tsx']), entry('a2', ['src/Alpha.tsx'])],
      translations: new Map(),
      glossaryTerms: [{ term: 'folder', translation: 'carpeta' }],
      surfaces,
      target: 10,
    });
    expect(glossaryUses[0].uses.map((use) => use.id)).toEqual(['New folder']);
    expect(picked[0].messages.map((m) => m.id)).toEqual(['a2']);
  });

  test('carries the translation alongside the English, and marks an empty one', () => {
    const { surfaces: picked } = selectMessages({
      entries: [entry('Save', ['src/Alpha.tsx']), entry('Cancel', ['src/Alpha.tsx'])],
      translations: new Map([['Save', 'Guardar']]),
      glossaryTerms: [],
      surfaces,
      target: 2,
    });
    expect(picked[0].messages).toMatchObject([
      { id: 'Save', translation: 'Guardar' },
      { id: 'Cancel', translation: '' },
    ]);
  });
});

describe('the packet', () => {
  const packetFor = (overrides = {}) =>
    buildPacket({
      locale: 'fr',
      status: { status: 'unreviewed', basis: '—' },
      offered: false,
      promotable: true,
      catalogStamp: '2026-01-01',
      messageCount: 2900,
      glossaryTerms: [{ term: 'folder', translation: 'dossier' }],
      neverTranslated: '- **OpenKnowledge** — the product name.',
      selection: {
        glossaryUses: [
          {
            term: 'folder',
            translation: 'dossier',
            uses: [{ id: 'New folder', source: 'New folder', translation: 'Nouveau dossier' }],
          },
        ],
        surfaces: [
          {
            surface: CHROME_SURFACES[0],
            messages: [{ id: 'Save', source: 'Save', translation: 'Enregistrer' }],
          },
        ],
      },
      ...overrides,
    });

  test('names the language in the language, so its reader recognises it', () => {
    expect(packetFor()).toMatch(/français/);
  });

  test('shows the English and the translation together for every numbered string', () => {
    const packet = packetFor();
    expect(packet).toMatch(/\*\*1\.\*\*\n- `en` — New folder\n- `fr` — Nouveau dossier/);
    expect(packet).toMatch(/\*\*2\.\*\*\n- `en` — Save\n- `fr` — Enregistrer/);
  });

  test('numbers run continuously across the glossary and the interface sections', () => {
    const numbers = [...packetFor().matchAll(/^\*\*(\d+)\.\*\*$/gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual([1, 2]);
  });

  test('tells a reviewer up front when approving will not promote the locale', () => {
    expect(packetFor({ promotable: false })).toMatch(/will not appear in the picker yet/);
    expect(packetFor({ promotable: true })).not.toMatch(/will not appear in the picker yet/);
  });

  test('does not tell a reviewer of an already-offered locale that it is unoffered', () => {
    const packet = packetFor({ offered: true });
    expect(packet).toMatch(/the app already offers the language/);
    expect(packet).toMatch(/nothing changes on screen/);
    expect(packet).not.toMatch(/is not offered in the app's language picker/);
  });

  test('tells a reviewer of an unoffered locale that approving adds it', () => {
    const packet = packetFor({ offered: false });
    expect(packet).toMatch(/is not offered in the app's language picker/);
    expect(packet).toMatch(/the language is added to the in-app language picker/);
  });

  test('says a locked word has no uses rather than silently omitting it', () => {
    const packet = packetFor({
      selection: {
        glossaryUses: [{ term: 'checkpoint', translation: 'point de contrôle', uses: [] }],
        surfaces: [],
      },
    });
    expect(packet).toMatch(/checkpoint → point de contrôle/);
    expect(packet).toMatch(/No interface message uses this word today/);
  });

  test('states the selection rule, so the sample is not mistaken for the whole catalog', () => {
    const packet = packetFor();
    expect(packet).toMatch(/How this sample was chosen/);
    expect(packet).toMatch(/2 strings out of 2900/);
  });

  test('folds a multi-line message onto one line so the list cannot break', () => {
    const packet = packetFor({
      selection: {
        glossaryUses: [],
        surfaces: [
          {
            surface: CHROME_SURFACES[0],
            messages: [{ id: 'a', source: 'one\ntwo', translation: 'un\ndeux' }],
          },
        ],
      },
    });
    expect(packet).toMatch(/- `en` — one ⏎ two/);
    expect(packet).toMatch(/- `fr` — un ⏎ deux/);
  });
});

describe('the command line', () => {
  test('takes the locale positionally, with or without an output file', () => {
    expect(parseArgs(['fr'])).toEqual({ locale: 'fr', out: null });
    expect(parseArgs(['fr', '--out', '/tmp/fr.md'])).toEqual({ locale: 'fr', out: '/tmp/fr.md' });
  });

  test('does not mistake the output path for the locale when the flag comes first', () => {
    expect(parseArgs(['--out', '/tmp/fr.md', 'fr'])).toEqual({ locale: 'fr', out: '/tmp/fr.md' });
  });

  test('reports no locale rather than guessing one', () => {
    expect(parseArgs([])).toEqual({ locale: null, out: null });
    expect(parseArgs(['--out', '/tmp/fr.md'])).toMatchObject({ locale: null });
  });
});

describe('the tracking table', () => {
  const status = readReviewStatus(REVIEW_MD);

  test('parses a row into its recorded fields', () => {
    expect(
      readReviewStatus(
        '| `fr` | français | reviewed | A. Reviewer | inkeep/open-knowledge#42 | — |',
      ),
    ).toEqual(
      new Map([
        [
          'fr',
          {
            language: 'français',
            status: 'reviewed',
            basis: 'A. Reviewer',
            evidence: 'inkeep/open-knowledge#42',
            blocker: '—',
          },
        ],
      ]),
    );
  });

  test('ignores the header separator and any prose around the table', () => {
    expect(readReviewStatus('| Locale | Language |\n| --- | --- |\nnot a row').size).toBe(0);
  });

  test('records every enumerated locale', () => {
    expect(SUPPORTED.filter((locale) => !status.has(locale))).toEqual([]);
  });

  test('uses only the four defined statuses', () => {
    const undefined_ = [...status.entries()]
      .filter(([, row]) => !['source', 'reviewed', 'vouched', 'unreviewed'].includes(row.status))
      .map(([locale, row]) => `${locale}: ${row.status}`);
    expect(undefined_).toEqual([]);
  });

  test('nothing is withheld from the picker without a recorded blocker', () => {
    const withheld = SUPPORTED.filter((locale) => !PICKER.includes(locale));
    const unexplained = withheld.filter((locale) => {
      const blocker = status.get(locale)?.blocker;
      return !blocker || blocker === '—';
    });
    expect(unexplained).toEqual([]);
  });

  test('every locale recorded as read says who read it and where to look', () => {
    const unsubstantiated = [...status.entries()]
      .filter(([, row]) => ['reviewed', 'vouched'].includes(row.status))
      .filter(([, row]) => !row.basis || row.basis === '—' || !row.evidence || row.evidence === '—')
      .map(([locale]) => locale);
    expect(unsubstantiated).toEqual([]);
  });

  test('nothing outside the picker is marked vouched', () => {
    const spurious = [...status.entries()]
      .filter(([locale, row]) => row.status === 'vouched' && !PICKER.includes(locale))
      .map(([locale]) => locale);
    expect(spurious).toEqual([]);
  });

  test('the locales whose layout is unfinished are recorded as blocked', () => {
    const unmarked = LAYOUT_DEFERRED.filter((locale) => {
      const blocker = status.get(locale)?.blocker;
      return !blocker || blocker === '—';
    });
    expect(unmarked).toEqual([]);
  });

  test('no other locale carries a blocker it does not have', () => {
    const spurious = [...status.entries()]
      .filter(([locale]) => !LAYOUT_DEFERRED.includes(locale))
      .filter(([, row]) => row.blocker && row.blocker !== '—')
      .map(([locale]) => locale);
    expect(spurious).toEqual([]);
  });

  test('no blocked locale is offered in the picker', () => {
    expect(PICKER.filter((locale) => LAYOUT_DEFERRED.includes(locale))).toEqual([]);
  });
});

describe('against the real catalogs', () => {
  const entries = parsePoEntries(SOURCE_CATALOG);

  test.each(
    CHROME_SURFACES.map((surface) => [surface.label, surface]),
  )('the %s surface still matches messages in the catalog', (_label, surface) => {
    const matched = entries.filter((entry) =>
      entry.references.some((ref) => surface.files.includes(ref)),
    );
    expect(matched.length).toBeGreaterThan(0);
  });

  test.each(
    CHROME_SURFACES.flatMap((surface) => surface.files.map((file) => [file])),
  )('%s is still a source of user-facing messages', (file) => {
    expect(entries.some((entry) => entry.references.includes(file))).toBe(true);
  });

  test('builds a packet for every locale but the source', () => {
    for (const locale of SUPPORTED.filter((tag) => tag !== 'en')) {
      const packet = generate({ locale });
      expect(packet, locale).toMatch(/## 1\. The locked vocabulary/);
      expect(packet, locale).toMatch(/## How this sample was chosen/);
    }
  });

  test('a packet for an offered locale reads as a check on what already ships', () => {
    for (const locale of PICKER.filter((tag) => tag !== 'en')) {
      expect(generate({ locale }), locale).toMatch(/the app already offers the language/);
    }
  });

  test('asks for about the number of strings it promises, not the whole catalog', () => {
    const numbers = [...generate({ locale: 'fr' }).matchAll(/^\*\*(\d+)\.\*\*$/gm)];
    expect(numbers.length).toBeGreaterThan(TARGET_MESSAGES * 0.75);
    expect(numbers.length).toBeLessThanOrEqual(TARGET_MESSAGES);
  });

  test('is byte-identical across runs, so numbered feedback keeps pointing at the same string', () => {
    expect(generate({ locale: 'hi' })).toBe(generate({ locale: 'hi' }));
  });

  test('never asks a reviewer to read the same string twice', () => {
    const shown = [...generate({ locale: 'fr' }).matchAll(/^- `en` — (.*)$/gm)].map((m) => m[1]);
    expect(shown.length).toBe(new Set(shown).size);
  });

  test('refuses the source locale, which has nothing to review', () => {
    expect(() => generate({ locale: 'en' })).toThrow(/nothing to review/);
  });

  test('refuses a locale the app does not enumerate', () => {
    expect(() => generate({ locale: 'sv' })).toThrow(/not an enumerated locale/);
  });

  test('runs from the command line', () => {
    const result = spawnSync('node', ['scripts/generate-locale-review-packet.mjs', 'bn'], {
      cwd: OK_ROOT,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/# Reviewing OpenKnowledge in/);
  });

  test('explains itself rather than throwing a stack trace when given no locale', () => {
    const result = spawnSync('node', ['scripts/generate-locale-review-packet.mjs'], {
      cwd: OK_ROOT,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Usage:/);
  });
});
