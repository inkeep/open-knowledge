import { describe, expect, test } from 'vitest';
import { aggregateStableChangelog } from './aggregate-stable-changelog.mjs';

// A raw beta body as produced by the beta cadence: a lead line, one bump-level
// subsection, then the internal consumed-set marker.
function betaBody({ lead, section }) {
  return `${lead}\n\n${section}\n\n<!-- ok-consumed-set: ["x"] -->\n`;
}

describe('aggregateStableChangelog', () => {
  test('merges bullets from many betas into one section per level (Major → Minor → Patch)', () => {
    const input = [
      betaBody({
        lead: 'Delta since previous beta (v0.31.0-beta.0) — 1 new changeset.',
        section: '### Minor Changes\n\n- Minor from beta.1',
      }),
      betaBody({
        lead: 'Delta since previous beta (v0.31.0-beta.1) — 1 new changeset.',
        section: '### Patch Changes\n\n- Patch from beta.2',
      }),
      betaBody({
        lead: 'Delta since previous beta (v0.31.0-beta.2) — 1 new changeset.',
        section: '### Patch Changes\n\n- Patch from beta.3',
      }),
      betaBody({
        lead: 'First beta of the cycle.',
        section: '### Major Changes\n\n- Major from beta.4',
      }),
    ].join('\n');

    expect(aggregateStableChangelog(input)).toBe(
      [
        '### Major Changes',
        '',
        '- Major from beta.4',
        '',
        '### Minor Changes',
        '',
        '- Minor from beta.1',
        '',
        '### Patch Changes',
        '',
        '- Patch from beta.2',
        '',
        '- Patch from beta.3',
        '',
      ].join('\n'),
    );
  });

  test('omits a level entirely when it has no changesets', () => {
    const input = betaBody({
      lead: 'First beta of the cycle.',
      section: '### Patch Changes\n\n- Only a patch',
    });
    const out = aggregateStableChangelog(input);
    expect(out).toBe('### Patch Changes\n\n- Only a patch\n');
    expect(out).not.toContain('Major Changes');
    expect(out).not.toContain('Minor Changes');
  });

  test('drops no preamble of its own — no version header or promotion note', () => {
    const out = aggregateStableChangelog(
      betaBody({ lead: 'First beta of the cycle.', section: '### Minor Changes\n\n- A change' }),
    );
    expect(out.startsWith('### Minor Changes')).toBe(true);
    expect(out).not.toContain('Stable promotion of beta');
    expect(out).not.toContain('Aggregated changes since previous stable');
    expect(out).not.toMatch(/^## \d/m);
  });

  test('strips per-beta bookkeeping lines (consumed-set marker, delta/first-beta lead)', () => {
    const out = aggregateStableChangelog(
      betaBody({
        lead: 'Delta since previous beta (v1.0.0-beta.0) — 2 new changesets.',
        section: '### Patch Changes\n\n- A patch',
      }),
    );
    expect(out).not.toContain('ok-consumed-set');
    expect(out).not.toContain('Delta since previous beta');
    expect(out).not.toContain('First beta of the cycle');
  });

  test('preserves a bullet body verbatim, including indented continuation paragraphs', () => {
    const bullet = [
      '- Report a bug from inside the app. Opens from Help → Report a Bug…',
      '',
      '  A second paragraph, indented two spaces, with `code` and a — dash.',
      '',
      '  A third paragraph.',
    ].join('\n');
    const out = aggregateStableChangelog(`### Minor Changes\n\n${bullet}\n`);
    expect(out).toBe(`### Minor Changes\n\n${bullet}\n`);
  });

  test('keeps multiple bullets within a single beta section', () => {
    const input = '### Patch Changes\n\n- First patch\n\n- Second patch\n\n- Third patch\n';
    expect(aggregateStableChangelog(input)).toBe(
      '### Patch Changes\n\n- First patch\n\n- Second patch\n\n- Third patch\n',
    );
  });

  test('tolerates h2 and h4 level headings (upstream heading-level drift)', () => {
    const input = '## Minor Changes\n\n- via h2\n\n#### Patch Changes\n\n- via h4\n';
    expect(aggregateStableChangelog(input)).toBe(
      '### Minor Changes\n\n- via h2\n\n### Patch Changes\n\n- via h4\n',
    );
  });

  test('empty input yields empty output (no headings emitted for absent levels)', () => {
    expect(aggregateStableChangelog('')).toBe('');
    expect(aggregateStableChangelog('\n\n')).toBe('');
  });
});
