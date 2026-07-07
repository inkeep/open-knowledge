import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyDuplication } from './persistence-tripwire.ts';

const FIXTURE_DIR = resolve(
  import.meta.dirname ?? new URL('.', import.meta.url).pathname,
  'persistence-tripwire.fixtures',
);

function load(name: string): string {
  return readFileSync(resolve(FIXTURE_DIR, name), 'utf-8');
}

describe('classifyDuplication — incident shape blocks', () => {
  test('exact 2x doubling of the .changeset/README incident shape blocks', () => {
    const base = load('incident-changeset-readme-doubled.base.md');
    const candidate = load('incident-changeset-readme-doubled.candidate.md');
    const result = classifyDuplication(candidate, base);
    expect(result.kind).toBe('block');
    if (result.kind === 'block') {
      expect(result.reason).toBe('structural-duplication');
      expect(result.copies).toBe(2);
    }
  });

  test('3x duplication blocks with copies=3', () => {
    const base = load('incident-changeset-readme-doubled.base.md');
    const candidate = `${base}\n\n${base}\n\n${base}`;
    const result = classifyDuplication(candidate, base);
    expect(result.kind).toBe('block');
    if (result.kind === 'block') {
      expect(result.copies).toBe(3);
    }
  });

  test('4x duplication blocks with copies=4', () => {
    const base = load('incident-changeset-readme-doubled.base.md');
    const candidate = [base, base, base, base].join('\n\n');
    const result = classifyDuplication(candidate, base);
    expect(result.kind).toBe('block');
    if (result.kind === 'block') {
      expect(result.copies).toBe(4);
    }
  });

  test('over-collapsed inter-copy whitespace still blocks', () => {
    const base = load('incident-changeset-readme-doubled.base.md');
    // Many blank lines and tabs between the copies are tolerated.
    const candidate = `${base}\n\n\n\n\t  \n\n${base}`;
    const result = classifyDuplication(candidate, base);
    expect(result.kind).toBe('block');
  });

  test('candidate with leading + trailing whitespace around 2 copies still blocks', () => {
    const base = load('incident-changeset-readme-doubled.base.md');
    const candidate = `\n\n  ${base}\n\n${base}\n  \n`;
    const result = classifyDuplication(candidate, base);
    expect(result.kind).toBe('block');
    if (result.kind === 'block') {
      expect(result.copies).toBe(2);
    }
  });

  test('frontmatter-only difference is treated as identical (allow)', () => {
    const base = load('incident-changeset-readme-doubled.base.md');
    const candidate = `---\ntitle: Changesets\n---\n${base}`;
    const result = classifyDuplication(candidate, base);
    expect(result.kind).toBe('allow');
    if (result.kind === 'allow') {
      expect(result.reason).toBe('identical');
    }
  });
});

describe('classifyDuplication — intentional duplicates do NOT block', () => {
  const intentional: Array<{ name: string; base: string; candidate: string }> = [
    {
      name: 'FAQ with intentionally repeated answer across audiences',
      base: 'intentional-faq-repeated-section.base.md',
      candidate: 'intentional-faq-repeated-section.candidate.md',
    },
    {
      name: 'doc with intentionally duplicated code blocks across runtime sections',
      base: 'intentional-doubled-code-blocks.base.md',
      candidate: 'intentional-doubled-code-blocks.candidate.md',
    },
    {
      name: '"see also" mirror page repeating glossary entries verbatim',
      base: 'intentional-see-also-mirror.base.md',
      candidate: 'intentional-see-also-mirror.candidate.md',
    },
  ];

  for (const fixture of intentional) {
    test(fixture.name, () => {
      const base = load(fixture.base);
      const candidate = load(fixture.candidate);
      const result = classifyDuplication(candidate, base);
      expect(result.kind).toBe('allow');
    });
  }
});

describe('classifyDuplication — boundary cases', () => {
  test('empty base never blocks', () => {
    expect(classifyDuplication('# anything\n', '').kind).toBe('allow');
    expect(
      classifyDuplication('# anything\n', '').kind === 'allow'
        ? classifyDuplication('# anything\n', '').reason
        : '',
    ).toBe('empty-base');
  });

  test('whitespace-only base normalizes to empty and never blocks', () => {
    const result = classifyDuplication('# anything\n', '   \n\n  \n');
    expect(result.kind).toBe('allow');
    if (result.kind === 'allow') {
      expect(result.reason).toBe('empty-base');
    }
  });

  test('identical (1x) candidate never blocks', () => {
    const base = load('incident-changeset-readme-doubled.base.md');
    const result = classifyDuplication(base, base);
    expect(result.kind).toBe('allow');
    if (result.kind === 'allow') {
      expect(result.reason).toBe('identical');
    }
  });

  test('candidate slightly larger than base but not an integer multiple is allowed', () => {
    const base = load('incident-changeset-readme-doubled.base.md');
    const candidate = `${base}\n\nThis is one extra paragraph the user wrote.\n`;
    const result = classifyDuplication(candidate, base);
    expect(result.kind).toBe('allow');
    if (result.kind === 'allow') {
      expect(result.reason).toBe('too-short');
    }
  });

  test('candidate that is two copies plus one trailing extra char returns allow as not-integer-multiple', () => {
    const base = 'short canonical body line';
    const candidate = `${base}\n\n${base}x`;
    const result = classifyDuplication(candidate, base);
    expect(result.kind).toBe('allow');
    if (result.kind === 'allow') {
      expect(result.reason).toBe('not-integer-multiple');
    }
  });

  test('candidate is base concatenated with unrelated content of equal length', () => {
    const base = 'AAA AAA AAA AAA AAA AAA';
    const candidate = `${base}\n\nBBB BBB BBB BBB BBB BBB`;
    const result = classifyDuplication(candidate, base);
    expect(result.kind).toBe('allow');
    if (result.kind === 'allow') {
      expect(result.reason).toBe('not-integer-multiple');
    }
  });

  test('partial copy (less than 2x) is allowed', () => {
    const base = load('incident-changeset-readme-doubled.base.md');
    const half = base.slice(0, Math.floor(base.length / 2));
    const candidate = `${base}\n\n${half}`;
    const result = classifyDuplication(candidate, base);
    expect(result.kind).toBe('allow');
  });

  test('candidate frontmatter is stripped before structural compare', () => {
    const base = 'paragraph one\n\nparagraph two';
    const candidate = `---\ntitle: doubled\n---\n${base}\n\n${base}`;
    const result = classifyDuplication(candidate, base);
    expect(result.kind).toBe('block');
    if (result.kind === 'block') {
      expect(result.copies).toBe(2);
    }
  });

  test('base whose body itself contains internal repetition still classifies a 2x candidate as block', () => {
    const base = 'repeat me\n\nrepeat me\n\nrepeat me';
    const candidate = `${base}\n\n${base}`;
    const result = classifyDuplication(candidate, base);
    expect(result.kind).toBe('block');
    if (result.kind === 'block') {
      expect(result.copies).toBe(2);
    }
  });
});
