import { describe, expect, test } from 'vitest';
import {
  buildPrecedentManifest,
  entriesFromManifest,
  parsePrecedentEntries,
  parsePrecedentOutline,
  precedentOutlineFrom,
  PRECEDENT_MANIFEST_VERSION,
  PrecedentManifestError,
  PrecedentRegistry,
  UnvalidatedPrecedentRegistry,
} from './precedents.mjs';

const SOUND = [
  '# Registry',
  '',
  'Two numbered slots, one active.',
  '',
  '## Conventions (precedents 1-2)',
  '',
  '1. **A live rule.** Body text.',
  '2. ~~**A withdrawn rule.**~~ **RETRACTED 2026-01-01** for citation stability.',
  '',
  '## A section that is itself the entry (precedent 3)',
  '',
  '**The rule states itself in the section body.**',
  '',
].join('\n');

const problemKinds = (markdown) =>
  parsePrecedentEntries(markdown).problems.map((problem) => problem.kind);

const numbered = (markdown) =>
  parsePrecedentEntries(markdown).entries.map((entry) => entry.number);

describe('the registry parser reads numbered entries, not heading ranges', () => {
  test('an entry carries its number, its form and whether it was retracted', () => {
    const { entries, problems } = parsePrecedentEntries(SOUND);

    expect(problems).toStrictEqual([]);
    expect(entries).toStrictEqual([
      { number: 1, form: 'list', retracted: false },
      { number: 2, form: 'list', retracted: true },
      { number: 3, form: 'heading', retracted: false },
    ]);
  });

  test('a heading that claims a range and writes every slot needs no per-slot heading', () => {
    expect(numbered(SOUND)).toStrictEqual([1, 2, 3]);
  });

  test('a heading claiming one slot with a list entry under it is a list entry, not a heading entry', () => {
    const markdown = SOUND.replace(
      '**The rule states itself in the section body.**',
      '3. **The rule is a list item.** Body.',
    );

    expect(parsePrecedentEntries(markdown).entries.at(-1)).toStrictEqual({
      number: 3,
      form: 'list',
      retracted: false,
    });
  });

  test('an empty section claiming a slot writes no entry, so the slot reads as unwritten', () => {
    const markdown = SOUND.replace('**The rule states itself in the section body.**', '');

    expect(numbered(markdown)).toStrictEqual([1, 2]);
    expect(problemKinds(markdown)).toStrictEqual(['claimed-but-unwritten']);
  });

  test('a number written twice is a problem, because no reader can tell which entry it means', () => {
    const markdown = SOUND.replace('2. ~~**A withdrawn', '1. ~~**A withdrawn');
    const [problem] = parsePrecedentEntries(markdown).problems;

    expect(problem.kind).toBe('duplicate');
    expect(problem.number).toBe(1);
    expect(problem.detail).toMatch(/line/);
  });

  test('an entry no heading claims is a problem, the other half of a renumbering', () => {
    const markdown = SOUND.replace('1. **A live rule.**', '9. **A live rule.**');

    expect(problemKinds(markdown).sort()).toStrictEqual(['claimed-but-unwritten', 'unclaimed']);
  });

  test('gaps in the numbering are a repository convention, not a parse problem', () => {
    const markdown = SOUND.replace('(precedents 1-2)', '(precedents 1, 2)').replace(
      '## A section that is itself the entry (precedent 3)',
      '## A section that is itself the entry (precedent 9)',
    );

    expect(numbered(markdown)).toStrictEqual([1, 2, 9]);
    expect(problemKinds(markdown)).toStrictEqual([]);
  });
});

describe('the registry answers both questions the classifier asks of it', () => {
  const registry = new PrecedentRegistry(parsePrecedentEntries(SOUND).entries);

  test('a written slot exists and a fabricated one does not', () => {
    expect(registry.has(1)).toBe(true);
    expect(registry.has(999)).toBe(false);
  });

  test('a retracted slot still exists, and says so separately', () => {
    expect(registry.has(2)).toBe(true);
    expect(registry.isRetracted(2)).toBe(true);
    expect(registry.isRetracted(1)).toBe(false);
  });

  test('the registry a foreign root gets validates nothing and retracts nothing', () => {
    const unvalidated = new UnvalidatedPrecedentRegistry();

    expect(unvalidated.has(999)).toBe(true);
    expect(unvalidated.isRetracted(2)).toBe(false);
    expect([...unvalidated]).toStrictEqual([]);
  });
});

describe('the shipped manifest is versioned, and an older reader survives a newer one', () => {
  const entries = parsePrecedentEntries(SOUND).entries;

  test('a manifest carries its schema major beside the entries', () => {
    expect(buildPrecedentManifest(entries)).toStrictEqual({
      version: PRECEDENT_MANIFEST_VERSION,
      entries,
    });
  });

  test('keys this reader does not know are additive, so a newer manifest still loads', () => {
    const newer = {
      version: PRECEDENT_MANIFEST_VERSION,
      generatedFrom: 'PRECEDENTS.md',
      entries: entries.map((entry) => ({ ...entry, title: 'a title this reader ignores' })),
    };

    expect(entriesFromManifest(newer, 'newer.json')).toStrictEqual(entries);
  });

  test('a schema major this reader does not recognize is named, never silently ignored', () => {
    const future = { ...buildPrecedentManifest(entries), version: PRECEDENT_MANIFEST_VERSION + 1 };

    expect(() => entriesFromManifest(future, 'future.json')).toThrow(PrecedentManifestError);
    expect(() => entriesFromManifest(future, 'future.json')).toThrow('future.json');
    expect(() => entriesFromManifest(future, 'future.json')).toThrow(
      new RegExp(`version ${PRECEDENT_MANIFEST_VERSION + 1}`),
    );
  });

  test('the flat number array of the previous schema is rejected by name, not coerced', () => {
    expect(() => entriesFromManifest([1, 2, 3], 'legacy.json')).toThrow(PrecedentManifestError);
    expect(() => entriesFromManifest([1, 2, 3], 'legacy.json')).toThrow('legacy.json');
  });

  test('an entry missing a field the classifier reads is rejected rather than defaulted', () => {
    const broken = { version: PRECEDENT_MANIFEST_VERSION, entries: [{ number: 1, form: 'list' }] };

    expect(() => entriesFromManifest(broken, 'broken.json')).toThrow(PrecedentManifestError);
    expect(() => entriesFromManifest(broken, 'broken.json')).toThrow(/retracted/);
  });
});

describe('the parser also reads the title of each entry, which is its bold lead', () => {
  const outline = () => parsePrecedentOutline(SOUND);

  test('every section keeps its heading line and the entries written under it', () => {
    expect(outline().sections.map((section) => section.heading)).toStrictEqual([
      '## Conventions (precedents 1-2)',
      '## A section that is itself the entry (precedent 3)',
    ]);
    expect(outline().sections.map((section) => section.entries.map((entry) => entry.number))).toStrictEqual([
      [1, 2],
      [3],
    ]);
  });

  test('an entry carries its title beside the fields the manifest reads', () => {
    expect(outline().sections.flatMap((section) => section.entries)).toStrictEqual([
      { number: 1, form: 'list', retracted: false, title: 'A live rule.' },
      { number: 2, form: 'list', retracted: true, title: 'A withdrawn rule.' },
      {
        number: 3,
        form: 'heading',
        retracted: false,
        title: 'The rule states itself in the section body.',
      },
    ]);
  });

  test('a title that wraps across lines reads as one line', () => {
    const wrapped = SOUND.replace(
      '**The rule states itself in the section body.**',
      '**The rule states itself\nin the section body.**',
    );

    expect(parsePrecedentOutline(wrapped).sections.at(-1).entries[0].title).toBe(
      'The rule states itself in the section body.',
    );
  });

  test('an entry with no bold lead is a problem, because the stub would have nothing to show', () => {
    const untitled = SOUND.replace('1. **A live rule.** Body text.', '1. A live rule with no lead.');

    expect(parsePrecedentOutline(untitled).problems.map((problem) => problem.kind)).toStrictEqual([
      'untitled',
    ]);
  });

  test('reading titles does not change what the numbers path reports', () => {
    const untitled = SOUND.replace('1. **A live rule.** Body text.', '1. A live rule with no lead.');

    expect(parsePrecedentEntries(untitled).problems).toStrictEqual([]);
    expect(numbered(untitled)).toStrictEqual([1, 2, 3]);
  });

  test('a registry the parser cannot read soundly is refused by name before any title is used', () => {
    const duplicated = SOUND.replace('2. ~~**A withdrawn', '1. ~~**A withdrawn');

    expect(() => precedentOutlineFrom(duplicated, 'duplicated.md')).toThrow(PrecedentManifestError);
    expect(() => precedentOutlineFrom(duplicated, 'duplicated.md')).toThrow('duplicated.md');
  });
});
