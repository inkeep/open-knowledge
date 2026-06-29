
import { describe, expect, test } from 'bun:test';
import { sharedExtensions } from '../../src/extensions/shared.ts';
import { MarkdownManager } from '../../src/markdown/index.ts';
import {
  compareParseHealth,
  harvestParseHealth,
  type ParseHealthBaseline,
} from './parse-health-gate.ts';

function makeBaseline(overrides: Partial<ParseHealthBaseline> = {}): ParseHealthBaseline {
  return {
    schemaVersion: 1,
    capturedAt: '2026-04-16T00:00:00.000Z',
    runnerClass: 'test-fixture',
    corpus: { commonmarkExamples: 652, gfmExamples: 20 },
    thresholds: { wholeDocMax: 0, blockLevelMax: 0 },
    observed: { parseFallback: { blockLevel: 0, wholeDoc: 0 } },
    ...overrides,
  };
}

describe('compareParseHealth (R19 synthetic gate)', () => {
  test('clean observed counters ⇒ PASS', () => {
    const baseline = makeBaseline();
    const report = compareParseHealth(baseline, {
      parseFallback: { blockLevel: 0, wholeDoc: 0 },
    });
    expect(report.pass).toBe(true);
    expect(report.findings).toEqual([]);
  });

  test('whole-doc fallback > 0 ⇒ FAIL (absolute threshold)', () => {
    const baseline = makeBaseline();
    const report = compareParseHealth(baseline, {
      parseFallback: { blockLevel: 0, wholeDoc: 1 },
    });
    expect(report.pass).toBe(false);
    expect(report.findings.some((f) => f.counter === 'wholeDoc')).toBe(true);
    const f = report.findings.find((x) => x.counter === 'wholeDoc');
    expect(f?.observed).toBe(1);
    expect(f?.threshold).toBe(0);
  });

  test('block-level fallback at baseline ceiling ⇒ PASS (boundary)', () => {
    const baseline = makeBaseline({
      thresholds: { wholeDocMax: 0, blockLevelMax: 3 },
      observed: { parseFallback: { blockLevel: 3, wholeDoc: 0 } },
    });
    const report = compareParseHealth(baseline, {
      parseFallback: { blockLevel: 3, wholeDoc: 0 },
    });
    expect(report.pass).toBe(true);
  });

  test('block-level fallback above baseline ⇒ FAIL', () => {
    const baseline = makeBaseline({
      thresholds: { wholeDocMax: 0, blockLevelMax: 3 },
    });
    const report = compareParseHealth(baseline, {
      parseFallback: { blockLevel: 4, wholeDoc: 0 },
    });
    expect(report.pass).toBe(false);
    const f = report.findings.find((x) => x.counter === 'blockLevel');
    expect(f?.observed).toBe(4);
    expect(f?.threshold).toBe(3);
  });

  test('both counters over ⇒ FAIL reports both findings', () => {
    const baseline = makeBaseline();
    const report = compareParseHealth(baseline, {
      parseFallback: { blockLevel: 1, wholeDoc: 1 },
    });
    expect(report.pass).toBe(false);
    const counters = report.findings.map((f) => f.counter).sort();
    expect(counters).toEqual(['blockLevel', 'wholeDoc']);
  });
});

describe('harvestParseHealth (R19 end-to-end fixture harvest)', () => {
  const CRASH_CLASSES: ReadonlyArray<{ id: string; input: string; className: string }> = [
    {
      id: 'C02',
      className: 'Lazy line in expression in container',
      input: '# Heading\n\n> {a\nb}\n\n# Footer\n',
    },
    {
      id: 'C15',
      className: 'JSX identifier with !',
      input: '# Heading\n\n<Foo.bar!>content</Foo.bar>\n\n# Footer\n',
    },
    {
      id: 'C16',
      className: 'JSX attribute name with ! and :',
      input: '# Heading\n\n<Foo a:b!>content</Foo>\n\n# Footer\n',
    },
    {
      id: 'C17',
      className: 'Closing slash without open',
      input: '# Heading\n\ntext </Bar> more\n\n# Footer\n',
    },
    {
      id: 'C20',
      className: 'Mismatched open/close tag names',
      input: '# Heading\n\n<Foo>broken</Bar>\n\n# Footer\n',
    },
  ];

  const CRASH_MDX = CRASH_CLASSES[3].input; // C17 — used by the end-to-end gate test.

  test('clean corpus ⇒ counters remain zero', () => {
    const corpus = ['# Heading\n\nParagraph.\n', 'Just text.\n', '- list item 1\n- list item 2\n'];
    const sample = harvestParseHealth({ corpus });
    expect(sample.parseFallback.wholeDoc).toBe(0);
    expect(sample.parseFallback.blockLevel).toBe(0);
  });

  for (const cls of CRASH_CLASSES) {
    test(`${cls.id} (${cls.className}) ⇒ block-level fallback increments, whole-doc stays 0`, () => {
      const sample = harvestParseHealth({ corpus: [cls.input] });
      expect(sample.parseFallback.blockLevel).toBeGreaterThan(0);
      expect(sample.parseFallback.wholeDoc).toBe(0);
    });
  }

  test('end-to-end: injected regression ⇒ gate FAILS with block-level finding', () => {
    const baseline = makeBaseline();
    const sample = harvestParseHealth({ corpus: [CRASH_MDX] });
    const report = compareParseHealth(baseline, sample);
    expect(report.pass).toBe(false);
    expect(report.findings.some((f) => f.counter === 'blockLevel')).toBe(true);
  });

  test('shared MarkdownManager instance can be reused across harvests', () => {
    const mm = new MarkdownManager({ extensions: sharedExtensions });
    const clean = harvestParseHealth({
      manager: mm,
      corpus: ['# heading\n'],
    });
    const dirty = harvestParseHealth({
      manager: mm,
      corpus: [CRASH_MDX],
    });
    expect(clean.parseFallback.blockLevel).toBe(0);
    expect(dirty.parseFallback.blockLevel).toBeGreaterThan(0);
  });
});
