
import { describe, expect, test } from 'bun:test';
import type { BrokenLink, RenderWarning, WriteWarning } from '@inkeep/open-knowledge-core';
import {
  formatAdvisoryBriefs,
  formatAdvisoryLines,
  formatBrokenLinkBrief,
  formatBrokenLinkLines,
  formatRenderWarningsBrief,
  formatRenderWarningsLine,
  parseAdvisoryWarnings,
  parseBrokenLinks,
} from './advisory-warnings.ts';

function mermaidWarning(overrides: Partial<RenderWarning> = {}): RenderWarning {
  return {
    kind: 'mermaid-parse-error',
    fenceIndex: 1,
    fenceFirstLine: 'sequenceDiagram',
    message: 'Parse error on line 2:\n...A->>B: hi; the\n--------^',
    line: 2,
    ...overrides,
  };
}

const DIVERGENCE: WriteWarning = {
  kind: 'content-divergence',
  intendedBytes: 100,
  actualBytes: 98,
  byteDelta: -2,
};

const RECONCILED: WriteWarning = {
  kind: 'disk-edit-reconciled',
  intendedBytes: 50,
  actualBytes: 80,
  byteDelta: 30,
};

describe('parseAdvisoryWarnings', () => {
  test('parses a valid mixed array and rejects absent/empty/malformed payloads', () => {
    expect(parseAdvisoryWarnings([mermaidWarning(), DIVERGENCE, RECONCILED])).toHaveLength(3);
    expect(parseAdvisoryWarnings(undefined)).toBeUndefined();
    expect(parseAdvisoryWarnings([])).toBeUndefined();
    expect(parseAdvisoryWarnings([{ kind: 'something-else' }])).toBeUndefined();
    expect(parseAdvisoryWarnings('not-an-array')).toBeUndefined();
  });

  test('unrecognized entries drop individually, keeping recognized siblings', () => {
    const parsed = parseAdvisoryWarnings([
      mermaidWarning(),
      { kind: 'future-fence-kind', payload: true },
      DIVERGENCE,
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed?.map((w) => w.kind)).toEqual(['mermaid-parse-error', 'content-divergence']);
  });
});

describe('formatAdvisoryLines', () => {
  test('one line per integrity entry plus one grouped render line', () => {
    const lines = formatAdvisoryLines([
      DIVERGENCE,
      RECONCILED,
      mermaidWarning(),
      mermaidWarning({ fenceIndex: 2 }),
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Content divergence');
    expect(lines[1]).toContain('reconciled');
    expect(lines[2]).toContain('2 mermaid fences');
  });

  test('integrity-only and render-only arrays each produce their own lines', () => {
    expect(formatAdvisoryLines([DIVERGENCE])).toHaveLength(1);
    expect(formatAdvisoryLines([mermaidWarning()])).toHaveLength(1);
  });

  test('single render failure inlines locator, line number, and mermaid message', () => {
    const [line] = formatAdvisoryLines([mermaidWarning()]);
    expect(line).toContain('⚠');
    expect(line).toContain('fence 1');
    expect(line).toContain('sequenceDiagram');
    expect(line).toContain('(line 2)');
    expect(line).toContain('Parse error on line 2:');
    expect(line).toContain('will not render');
  });

  test('empty fence body renders the (empty fence) locator, not ("")', () => {
    const [line] = formatAdvisoryLines([mermaidWarning({ fenceFirstLine: '' })]);
    expect(line).toContain('(empty fence)');
    expect(line).not.toContain('("")');
  });

  test('no line number omits the (line N) qualifier', () => {
    const [line] = formatAdvisoryLines([mermaidWarning({ line: undefined })]);
    expect(line).toContain('fence 1');
    expect(line).not.toContain('(line ');
    expect(line).toContain('will not render');
  });
});

describe('formatAdvisoryBriefs', () => {
  test('mixed advisories produce per-family briefs', () => {
    const briefs = formatAdvisoryBriefs([RECONCILED, mermaidWarning()]);
    expect(briefs).toHaveLength(2);
    expect(briefs[0]).toContain('reconciled');
    expect(briefs[1]).toContain('1 mermaid fence will not render');
    expect(briefs[1]).not.toContain('fences');
  });

  test('plural form for multiple render warnings', () => {
    const briefs = formatAdvisoryBriefs([mermaidWarning(), mermaidWarning({ fenceIndex: 2 })]);
    expect(briefs[0]).toContain('2 mermaid fences');
  });
});

describe('render-family bounds phrasing', () => {
  test('a full page of 10 entries reads as 10+ (server caps render entries)', () => {
    const warnings = Array.from({ length: 10 }, (_, i) => mermaidWarning({ fenceIndex: i + 1 }));
    expect(formatRenderWarningsLine(warnings)).toContain('10+');
    expect(formatRenderWarningsBrief(warnings)).toContain('10+');
  });
});


const noSuchDoc: BrokenLink = {
  href: './wiki/x',
  resolvedTo: 'wiki/wiki/x',
  reason: 'no-such-doc',
};
const unresolvable: BrokenLink = {
  href: '../../escape.md',
  resolvedTo: null,
  reason: 'unresolvable',
};
const noSuchFile: BrokenLink = {
  href: '../src/foo.py',
  resolvedTo: 'src/foo.py',
  reason: 'no-such-file',
};

describe('parseBrokenLinks', () => {
  test('parses a well-formed array (all three reasons)', () => {
    expect(parseBrokenLinks([noSuchDoc, noSuchFile, unresolvable])).toEqual([
      noSuchDoc,
      noSuchFile,
      unresolvable,
    ]);
  });

  test('drops malformed entries but keeps valid ones', () => {
    const mixed = [
      noSuchDoc,
      { href: 'x', resolvedTo: null, reason: 'broken-anchor' }, // invalid reason
      { href: 42 }, // wrong types
      unresolvable,
    ];
    expect(parseBrokenLinks(mixed)).toEqual([noSuchDoc, unresolvable]);
  });

  test('returns [] for a non-array (absent / wrong-typed field)', () => {
    expect(parseBrokenLinks(undefined)).toEqual([]);
    expect(parseBrokenLinks(null)).toEqual([]);
    expect(parseBrokenLinks('nope')).toEqual([]);
    expect(parseBrokenLinks({})).toEqual([]);
  });

  test('returns [] for an empty array (the all-resolve confirmation)', () => {
    expect(parseBrokenLinks([])).toEqual([]);
  });
});

describe('formatBrokenLinkLines', () => {
  test('no links → no lines (clean write stays quiet)', () => {
    expect(formatBrokenLinkLines([])).toEqual([]);
  });

  test('one link → singular header + a bullet with resolvedTo', () => {
    const lines = formatBrokenLinkLines([noSuchDoc]);
    expect(lines[0]).toContain('1 broken outbound link —');
    expect(lines[0]).not.toContain('links —');
    expect(lines[1]).toBe('  • ./wiki/x → wiki/wiki/x (no-such-doc)');
  });

  test('null resolvedTo omits the arrow', () => {
    const lines = formatBrokenLinkLines([unresolvable]);
    expect(lines[1]).toBe('  • ../../escape.md (unresolvable)');
    expect(lines[1]).not.toContain('→');
  });

  test('a no-such-file entry renders the resolved path + reason', () => {
    const lines = formatBrokenLinkLines([noSuchFile]);
    expect(lines[1]).toBe('  • ../src/foo.py → src/foo.py (no-such-file)');
  });

  test('N links → plural header + one bullet each', () => {
    const lines = formatBrokenLinkLines([noSuchDoc, unresolvable]);
    expect(lines[0]).toContain('2 broken outbound links —');
    expect(lines).toHaveLength(3);
  });
});

describe('formatBrokenLinkBrief', () => {
  test('no links → null (nothing appended to the batch line)', () => {
    expect(formatBrokenLinkBrief([])).toBeNull();
  });

  test('one link → singular brief', () => {
    expect(formatBrokenLinkBrief([noSuchDoc])).toBe('⚠ 1 broken outbound link (see brokenLinks).');
  });

  test('N links → plural brief', () => {
    expect(formatBrokenLinkBrief([noSuchDoc, unresolvable])).toBe(
      '⚠ 2 broken outbound links (see brokenLinks).',
    );
  });
});
