import { describe, expect, test } from 'bun:test';
import { propertiesToFrontmatter } from './properties-frontmatter.ts';

const KEYS = new Set(['Status', 'Owner', 'Priority', 'White-Paper / E-Book?', 'Target Metric']);

describe('propertiesToFrontmatter', () => {
  test('lifts the property block under the H1 into leading frontmatter', () => {
    const input = [
      '# What are the perils of building today',
      '',
      'Status: Todo',
      'Owner: Omar Nasser',
      'Priority: Medium',
      '',
      '## Task description',
      '',
      'Provide an overview.',
      '',
    ].join('\n');
    const out = propertiesToFrontmatter(input, KEYS);
    expect(out).toBe(
      [
        '---',
        'Status: Todo',
        'Owner: Omar Nasser',
        'Priority: Medium',
        '---',
        '',
        '# What are the perils of building today',
        '',
        '## Task description',
        '',
        'Provide an overview.',
        '',
      ].join('\n'),
    );
  });

  test('quotes keys and values that are not YAML-plain', () => {
    const input = [
      '# Row',
      '',
      'White-Paper / E-Book?: No',
      'Target Metric: Blog to Demo > 0.38%',
      '',
    ].join('\n');
    const out = propertiesToFrontmatter(input, KEYS);
    expect(out).toContain('"White-Paper / E-Book?": No');
    expect(out).toContain('Target Metric: "Blog to Demo > 0.38%"');
  });

  test('keeps comma-joined multi-select values as one quoted scalar (lossless)', () => {
    const input = ['# Row', '', 'Status: Done, Shipped, Archived', ''].join('\n');
    const out = propertiesToFrontmatter(input, new Set(['Status']));
    expect(out).toContain('Status: "Done, Shipped, Archived"');
  });

  test('force-quotes YAML-typed values so text is not coerced to bool/null/number', () => {
    const keys = new Set(['Active', 'Deleted', 'Count', 'Ratio', 'Hex']);
    const input = [
      '# Row',
      '',
      'Active: true',
      'Deleted: null',
      'Count: 1234',
      'Ratio: 3.14',
      'Hex: 0xFF',
      '',
    ].join('\n');
    const out = propertiesToFrontmatter(input, keys);
    expect(out).toContain('Active: "true"');
    expect(out).toContain('Deleted: "null"');
    expect(out).toContain('Count: "1234"');
    expect(out).toContain('Ratio: "3.14"');
    expect(out).toContain('Hex: "0xFF"');
  });

  test('does not capture body prose that merely looks like a key line', () => {
    const input = [
      '# Row',
      '',
      'Status: Todo',
      '',
      'Note: this is body prose, not a property.',
      '',
    ].join('\n');
    const out = propertiesToFrontmatter(input, new Set(['Status']));
    expect(out).toContain('Status: Todo');
    expect(out).toContain('Note: this is body prose, not a property.');
    // The prose line stays in the body, not the frontmatter.
    expect(out.indexOf('Note:')).toBeGreaterThan(out.indexOf('---', 3));
  });

  test('leaves a page that already has frontmatter unchanged (idempotent)', () => {
    const input = ['---', 'Status: Todo', '---', '', '# Row', ''].join('\n');
    expect(propertiesToFrontmatter(input, KEYS)).toBe(input);
  });

  test('leaves a non-database page (no known keys matched) unchanged', () => {
    const input = ['# Just a page', '', 'Some prose here.', ''].join('\n');
    expect(propertiesToFrontmatter(input, KEYS)).toBe(input);
  });
});
