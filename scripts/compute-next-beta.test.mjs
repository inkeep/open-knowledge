import { describe, expect, test } from 'bun:test';
import {
  bumpSemver,
  computeBaseVersion,
  extractDeltaSection,
  maxBumpType,
  parseFrontmatterBumpType,
  parseSection,
  renderNotes,
} from './compute-next-beta.mjs';

describe('extractDeltaSection', () => {
  test('returns content between first ## heading and second ## heading, excluding the heading line', () => {
    const input = `# @inkeep/foo

## 0.5.0-beta.6

### Patch Changes

- abc1234: new content

## 0.5.0-beta.5

### Patch Changes

- old: prior content
`;
    expect(extractDeltaSection(input)).toBe(`
### Patch Changes

- abc1234: new content
`);
  });

  test('handles CHANGELOG with only one ## heading (no prior versions)', () => {
    const input = `# @inkeep/foo

## 0.5.0-beta.0

### Minor Changes

- aaaa: first version
`;
    expect(extractDeltaSection(input)).toBe(`
### Minor Changes

- aaaa: first version
`);
  });

  test('returns null when no ## heading exists', () => {
    expect(extractDeltaSection('# @inkeep/foo\n\nNo versions yet.\n')).toBeNull();
  });

  test('handles empty new section (no entries between versions)', () => {
    const input = `# @inkeep/foo

## 0.5.0-beta.4

## 0.5.0-beta.3

### Patch Changes

- old: prior
`;
    // Just the trailing blank line between the two ## headings.
    expect(extractDeltaSection(input)).toBe('');
  });
});

describe('parseSection', () => {
  test('groups entries by ### subheading', () => {
    const section = `
### Minor Changes

- aaaaaa: a minor change

### Patch Changes

- bbbbbb: a patch change
`;
    const result = parseSection(section);
    expect(Object.keys(result).sort()).toEqual(['Minor Changes', 'Patch Changes']);
    expect(result['Minor Changes']).toHaveLength(1);
    expect(result['Minor Changes'][0].hash).toBe('aaaaaa');
    expect(result['Patch Changes'][0].hash).toBe('bbbbbb');
  });

  test('preserves multi-line body with 2-space dedent', () => {
    const section = `### Patch Changes

- abc1234: first line

  Second paragraph after blank line.

  - nested bullet
    - even more nested
`;
    const groups = parseSection(section);
    const body = groups['Patch Changes'][0].body;
    expect(body).toBe(
      'first line\n\nSecond paragraph after blank line.\n\n- nested bullet\n  - even more nested',
    );
  });

  test('handles entries without commit-hash prefix', () => {
    const section = `### Patch Changes

- Updated dependencies [abc1234]
  - @inkeep/open-knowledge-core@0.5.0
`;
    const groups = parseSection(section);
    expect(groups['Patch Changes']).toHaveLength(1);
    expect(groups['Patch Changes'][0].hash).toBeNull();
    expect(groups['Patch Changes'][0].body.startsWith('Updated dependencies')).toBe(true);
  });
});

describe('renderNotes', () => {
  const baseInput = {
    newConsumedSet: ['a', 'b'],
    prevBetaTag: 'v0.5.0-beta.6',
    newCount: 2,
  };

  test('dedupes entries by commit hash across packages', () => {
    const packageDeltas = {
      cli: `### Patch Changes

- abc1234: shared fix

  body text
`,
      app: `### Patch Changes

- abc1234: shared fix

  body text
`,
    };
    const notes = renderNotes({ ...baseInput, packageDeltas });
    const bullets = notes.split('\n').filter((l) => l.startsWith('- '));
    expect(bullets).toHaveLength(1);
  });

  test('drops "Updated dependencies" boilerplate entries', () => {
    const packageDeltas = {
      app: `### Patch Changes

- abc1234: real change

  body

- Updated dependencies [abc1234]
  - @inkeep/open-knowledge-core@0.5.0
`,
    };
    const notes = renderNotes({ ...baseInput, packageDeltas });
    expect(notes).not.toContain('Updated dependencies');
    expect(notes).toContain('real change');
  });

  test('drops top-level fixed-group sibling-bump bullets', () => {
    // Changesets emits `- @inkeep/<pkg>@<version>` as a direct bullet in
    // non-cli packages' CHANGELOG fragments. The version stamped is the
    // pre-mode-computed bump (e.g., beta.6), which is unrelated to the
    // workflow-resolved -beta.N tag (e.g., beta.46) the release ships as.
    // These bullets are boilerplate cross-references — drop them.
    const packageDeltas = {
      core: `### Patch Changes

- @inkeep/open-knowledge-core@0.5.0-beta.6
`,
      server: `### Patch Changes

- @inkeep/open-knowledge-server@0.5.0-beta.6
`,
      cli: `### Patch Changes

- abc1234: real narrative change
`,
    };
    const notes = renderNotes({ ...baseInput, packageDeltas });
    expect(notes).not.toContain('@inkeep/open-knowledge-core@');
    expect(notes).not.toContain('@inkeep/open-knowledge-server@');
    expect(notes).toContain('real narrative change');
  });

  test('groups by bump type in canonical order (Major → Minor → Patch)', () => {
    const packageDeltas = {
      cli: `### Patch Changes

- p1: patch one

### Minor Changes

- m1: minor one
`,
    };
    const notes = renderNotes({ ...baseInput, packageDeltas });
    const minorIdx = notes.indexOf('### Minor Changes');
    const patchIdx = notes.indexOf('### Patch Changes');
    expect(minorIdx).toBeGreaterThan(-1);
    expect(patchIdx).toBeGreaterThan(-1);
    expect(minorIdx).toBeLessThan(patchIdx);
  });

  test('strips commit-hash prefix from rendered bullets', () => {
    const packageDeltas = {
      cli: `### Patch Changes

- 67028e1: fix(desktop): clear stale versionPendingInstall
`,
    };
    const notes = renderNotes({ ...baseInput, packageDeltas });
    expect(notes).not.toContain('67028e1');
    expect(notes).toContain('fix(desktop): clear stale versionPendingInstall');
  });

  test('embeds consumed-set marker at end', () => {
    const notes = renderNotes({
      ...baseInput,
      packageDeltas: { cli: '### Patch Changes\n\n- x: y\n' },
    });
    expect(notes).toMatch(/<!-- ok-consumed-set: \["a","b"\] -->$/);
  });

  test('writes "Delta since previous beta" header when prevBetaTag provided', () => {
    const notes = renderNotes({
      ...baseInput,
      packageDeltas: { cli: '### Patch Changes\n\n- x: y\n' },
    });
    expect(notes).toContain('Delta since previous beta ([v0.5.0-beta.6]');
    expect(notes).toContain('— 2 new changesets');
  });

  test('writes "First beta of the cycle" header when prevBetaTag is null', () => {
    const notes = renderNotes({
      ...baseInput,
      prevBetaTag: null,
      packageDeltas: { cli: '### Patch Changes\n\n- x: y\n' },
    });
    expect(notes).toContain('First beta of the cycle');
    expect(notes).not.toContain('Delta since previous beta');
  });

  test('pluralizes "changeset" / "changesets" correctly', () => {
    const single = renderNotes({
      ...baseInput,
      newCount: 1,
      packageDeltas: { cli: '### Patch Changes\n\n- x: y\n' },
    });
    expect(single).toContain('1 new changeset.');
    expect(single).not.toContain('1 new changesets');
  });
});

describe('round-trip: extractDeltaSection → parseSection → renderNotes', () => {
  test('multi-package CHANGELOG harvest produces a single deduplicated note', () => {
    const cliChangelog = `# @inkeep/open-knowledge

## 0.5.0-beta.7

### Patch Changes

- abc1234: fix(desktop): MCP wiring repair

  Multiple lines of body content
  span paragraphs.

- Updated dependencies [abc1234]
  - @inkeep/open-knowledge-core@0.5.0-beta.7

## 0.5.0-beta.6

### Patch Changes

- old: prior beta entry
`;
    const appChangelog = `# @inkeep/open-knowledge-app

## 0.5.0-beta.7

### Patch Changes

- abc1234: fix(desktop): MCP wiring repair

  Multiple lines of body content
  span paragraphs.

- def5678: fix(app): jsx selection UX

  app-only change

## 0.5.0-beta.6
`;
    const packageDeltas = {
      cli: extractDeltaSection(cliChangelog),
      app: extractDeltaSection(appChangelog),
    };
    const notes = renderNotes({
      packageDeltas,
      newConsumedSet: ['mcp-repair', 'jsx-selection'],
      prevBetaTag: 'v0.5.0-beta.6',
      newCount: 2,
    });

    // abc1234 should appear once despite being in both packages.
    const occurrences = (notes.match(/MCP wiring repair/g) || []).length;
    expect(occurrences).toBe(1);
    // def5678 (app-only) should appear once.
    expect(notes).toContain('jsx selection UX');
    // Updated dependencies bulletboard must not leak through.
    expect(notes).not.toContain('Updated dependencies');
    // Marker at end.
    expect(notes).toMatch(/<!-- ok-consumed-set:.*-->$/);
  });
});

describe('bumpSemver', () => {
  test('bumps each level', () => {
    expect(bumpSemver('0.5.0', 'patch')).toBe('0.5.1');
    expect(bumpSemver('0.5.0', 'minor')).toBe('0.6.0');
    expect(bumpSemver('0.4.7', 'major')).toBe('1.0.0');
  });

  test('minor/major zero out lower components', () => {
    expect(bumpSemver('0.5.3', 'minor')).toBe('0.6.0');
    expect(bumpSemver('1.2.3', 'major')).toBe('2.0.0');
  });

  test('throws on a non X.Y.Z version', () => {
    expect(() => bumpSemver('0.5', 'patch')).toThrow(/Invalid version/);
    expect(() => bumpSemver('0.5.0-beta.1', 'patch')).toThrow(/Invalid version/);
  });

  test('throws on an unknown bump type', () => {
    expect(() => bumpSemver('0.5.0', 'mega')).toThrow(/Invalid bump type/);
  });
});

describe('maxBumpType', () => {
  test('floors to patch on empty / null-only input', () => {
    expect(maxBumpType([])).toBe('patch');
    expect(maxBumpType([null, null])).toBe('patch');
  });

  test('returns the highest declared bump', () => {
    expect(maxBumpType(['patch', 'patch'])).toBe('patch');
    expect(maxBumpType(['patch', 'minor'])).toBe('minor');
    expect(maxBumpType(['minor', 'major', 'patch'])).toBe('major');
    expect(maxBumpType([null, 'minor', null])).toBe('minor');
  });
});

describe('computeBaseVersion — normative cadence vectors', () => {
  // base = anchor bumped by the max bump-type accumulated since the
  // last stable. Each row is the pile as it grows cut-by-cut from a clean
  // 0.5.0 stable. -beta.N counter is owned by release.yml (tag scan), not
  // here, so these only pin the base.
  const ANCHOR = '0.5.0';

  test('V1 — linear patches stay on one base', () => {
    expect(computeBaseVersion(ANCHOR, ['patch'])).toBe('0.5.1');
    expect(computeBaseVersion(ANCHOR, ['patch', 'patch'])).toBe('0.5.1');
    expect(computeBaseVersion(ANCHOR, ['patch', 'patch', 'patch'])).toBe('0.5.1');
  });

  test('V2 — a minor mid-cycle raises the base', () => {
    expect(computeBaseVersion(ANCHOR, ['patch'])).toBe('0.5.1');
    expect(computeBaseVersion(ANCHOR, ['patch', 'minor'])).toBe('0.6.0');
    expect(computeBaseVersion(ANCHOR, ['patch', 'minor', 'patch'])).toBe('0.6.0');
  });

  // Pins the math layer; check-no-major-changeset.sh prevents a 'major' from
  // reaching here in a real cycle.
  test('V3 — a major dominates the whole cycle', () => {
    expect(computeBaseVersion(ANCHOR, ['major'])).toBe('1.0.0');
    expect(computeBaseVersion(ANCHOR, ['major', 'minor'])).toBe('1.0.0');
    expect(computeBaseVersion(ANCHOR, ['major', 'minor', 'patch'])).toBe('1.0.0');
  });

  test('V4 — batched minors collapse to one minor base', () => {
    expect(computeBaseVersion(ANCHOR, ['minor'])).toBe('0.6.0');
    expect(computeBaseVersion(ANCHOR, ['minor', 'minor'])).toBe('0.6.0');
    expect(computeBaseVersion(ANCHOR, ['minor', 'minor', 'patch'])).toBe('0.6.0');
  });

  test('patch floor — a cycle with no recognizable bump still advances a patch', () => {
    expect(computeBaseVersion(ANCHOR, [])).toBe('0.5.1');
    expect(computeBaseVersion(ANCHOR, [null])).toBe('0.5.1');
  });

  test('propagates an invalid anchor as a throw', () => {
    expect(() => computeBaseVersion('0.5', ['patch'])).toThrow(/Invalid version/);
  });
});

describe('parseFrontmatterBumpType', () => {
  test('returns the max bump declared across the frontmatter block', () => {
    const cs = `---\n"@inkeep/open-knowledge": minor\n"@inkeep/open-knowledge-app": patch\n---\n\nbody`;
    expect(parseFrontmatterBumpType(cs)).toBe('minor');
  });

  test('returns major when a changeset declares a major bump', () => {
    const cs = `---\n"@inkeep/open-knowledge": major\n---\n\nbody`;
    expect(parseFrontmatterBumpType(cs)).toBe('major');
  });

  test('returns null when there is no frontmatter', () => {
    expect(parseFrontmatterBumpType('no frontmatter here')).toBeNull();
  });
});
