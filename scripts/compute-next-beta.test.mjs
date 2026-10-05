import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import {
  bumpSemver,
  computeBaseVersion,
  extractDeltaSection,
  maxBumpType,
  maxReleaseType,
  parseSection,
  previousBeta,
  RELEASE_LIST_ARGS,
  recordedReleases,
  releaseViewArgs,
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

  test('keeps a de-indented continuation line without truncating the entry', () => {
    const section = `### Patch Changes

- abc1234: intro sentence with a wrapped span \`ok diagnose
--redact\` and a tail sentence that must survive.
`;
    const groups = parseSection(section);
    expect(groups['Patch Changes']).toHaveLength(1);
    const body = groups['Patch Changes'][0].body;
    expect(body).toContain('--redact` and a tail sentence that must survive.');
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

    const occurrences = (notes.match(/MCP wiring repair/g) || []).length;
    expect(occurrences).toBe(1);
    expect(notes).toContain('jsx selection UX');
    expect(notes).not.toContain('Updated dependencies');
    expect(notes).toMatch(/<!-- ok-consumed-set:.*-->$/);
  });

  test('does not truncate an entry whose body has a prettier-de-indented code-span wrap', () => {
    const cliChangelog = `# @inkeep/open-knowledge

## 0.34.0

### Patch Changes

- abc1234: Migrate the toolchain from Bun to pnpm 10 and Vitest 4.

  Two small behavioral deltas ride along with the swap: \`ok diagnose
--redact\` bundles now derive doc-name tokens with sha256 instead of BLAKE2b-256;
  and the file-copy API now returns HTTP 409 (previously an unhandled 500).

## 0.33.0

### Patch Changes

- old: prior beta entry
`;
    const notes = renderNotes({
      packageDeltas: { cli: extractDeltaSection(cliChangelog) },
      newConsumedSet: ['remove-bun-toolchain-migration'],
      prevBetaTag: 'v0.33.0-beta.12',
      newCount: 1,
    });
    expect(notes).toContain('`ok diagnose');
    expect(notes).toContain('--redact` bundles now derive');
    expect(notes).toContain('HTTP 409');
    expect(notes).toContain('unhandled 500');
    expect(notes).not.toContain('prior beta entry');
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

describe('maxReleaseType', () => {
  test('returns the max bump across the releases Changesets read from one changeset', () => {
    const releases = [
      { name: '@inkeep/open-knowledge', type: 'minor' },
      { name: '@inkeep/open-knowledge-app', type: 'patch' },
    ];
    expect(maxReleaseType(releases)).toBe('minor');
  });

  test('returns major when any release is major', () => {
    expect(maxReleaseType([{ name: '@inkeep/open-knowledge', type: 'major' }])).toBe('major');
  });

  test('returns null for a changeset that declares no release', () => {
    expect(maxReleaseType([])).toBeNull();
  });

  test('ignores a none release, which bumps nothing', () => {
    expect(maxReleaseType([{ name: '@inkeep/open-knowledge', type: 'none' }])).toBeNull();
    expect(
      maxReleaseType([
        { name: '@inkeep/open-knowledge', type: 'none' },
        { name: '@inkeep/open-knowledge-app', type: 'patch' },
      ]),
    ).toBe('patch');
  });
});

describe('previousBeta reads the previous beta through the gh calls it is handed', () => {
  const TAG = 'v0.82.0-beta.8';
  const answering = (list, view) => (args) => {
    if (args[1] === 'list') return list;
    if (args[1] === 'view' && args[2] === TAG) return view;
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
  const body = (marker) => `Notes.\n${marker}\n`;

  test.each([
    ['a failed list bootstraps', { status: 1, stdout: '', stderr: 'HTTP 502' }, null, { prevBetaTag: null, recovered: null }],
    ['an empty list bootstraps', ok('\n'), null, { prevBetaTag: null, recovered: null }],
    ['a failed view keeps the tag and bootstraps the set', ok(`${TAG}\n`), { status: 1, stdout: '', stderr: '' }, { prevBetaTag: TAG, recovered: null }],
    ['a body without a marker bootstraps the set', ok(`${TAG}\n`), ok(body('no marker here')), { prevBetaTag: TAG, recovered: null }],
    ['a marker that is not JSON bootstraps the set', ok(`${TAG}\n`), ok(body('<!-- ok-consumed-set: [a, b] -->')), { prevBetaTag: TAG, recovered: null }],
    ['a marker that is not a string array bootstraps the set', ok(`${TAG}\n`), ok(body('<!-- ok-consumed-set: [1, 2] -->')), { prevBetaTag: TAG, recovered: null }],
    ['a well-formed marker is the consumed set', ok(`${TAG}\n`), ok(body('<!-- ok-consumed-set: ["a","b"] -->')), { prevBetaTag: TAG, recovered: ['a', 'b'] }],
    ['a quoted tag is unquoted', ok(`"${TAG}"\n`), ok(body('<!-- ok-consumed-set: ["a"] -->')), { prevBetaTag: TAG, recovered: ['a'] }],
  ])('%s', (_, list, view, expected) => {
    expect(previousBeta(answering(list, view))).toEqual(expected);
  });

  test('the list and view calls are the queries the read-releases job runs', () => {
    const calls = [];
    previousBeta((args) => {
      calls.push(args);
      return args[1] === 'list' ? ok(`${TAG}\n`) : ok(body('<!-- ok-consumed-set: [] -->'));
    });
    expect(calls).toEqual([RELEASE_LIST_ARGS, releaseViewArgs(TAG)]);
    expect(RELEASE_LIST_ARGS.slice(0, 3)).toEqual(['release', 'list', '--repo']);
    expect(RELEASE_LIST_ARGS.at(-1)).toBe(
      '[.[] | select(.isPrerelease) | select(.tagName | test("^v[0-9]+\\\\.[0-9]+\\\\.[0-9]+-beta\\\\.[0-9]+$")) | .tagName] | first // ""',
    );
  });
});

describe('recordedReleases replays what the read-releases job recorded', () => {
  const TAG = 'v0.82.0-beta.8';
  const recorded = {
    RELEASE_LIST_STATUS: '0',
    RELEASE_LIST_STDOUT: TAG,
    RELEASE_LIST_STDERR: '',
    RELEASE_VIEW_TAG: TAG,
    RELEASE_VIEW_STATUS: '0',
    RELEASE_VIEW_STDOUT: 'Notes.\n<!-- ok-consumed-set: ["a"] -->',
  };

  test('answers the recorded list and view calls', () => {
    const gh = recordedReleases(recorded);
    expect(gh(RELEASE_LIST_ARGS)).toEqual({ status: 0, stdout: TAG, stderr: '' });
    expect(gh(releaseViewArgs(TAG))).toEqual({ status: 0, stdout: recorded.RELEASE_VIEW_STDOUT, stderr: '' });
    expect(previousBeta(gh)).toEqual({ prevBetaTag: TAG, recovered: ['a'] });
  });

  test('replays a failed list with its status and stderr', () => {
    const gh = recordedReleases({ RELEASE_LIST_STATUS: '1', RELEASE_LIST_STDOUT: '', RELEASE_LIST_STDERR: 'HTTP 502' });
    expect(gh(RELEASE_LIST_ARGS)).toEqual({ status: 1, stdout: '', stderr: 'HTTP 502' });
    expect(previousBeta(gh)).toEqual({ prevBetaTag: null, recovered: null });
  });

  test.each([
    ['an empty list status', { ...recorded, RELEASE_LIST_STATUS: '' }, RELEASE_LIST_ARGS, 'RELEASE_LIST_STATUS is ""'],
    ['a missing list status', (({ RELEASE_LIST_STATUS: _, ...rest }) => rest)(recorded), RELEASE_LIST_ARGS, 'RELEASE_LIST_STATUS is missing'],
    ['a list status that is not a number', { ...recorded, RELEASE_LIST_STATUS: '0\n' }, RELEASE_LIST_ARGS, 'RELEASE_LIST_STATUS is "0\\n"'],
    ['an empty view status', { ...recorded, RELEASE_VIEW_STATUS: '' }, releaseViewArgs(TAG), 'RELEASE_VIEW_STATUS is ""'],
    ['a missing view status', (({ RELEASE_VIEW_STATUS: _, ...rest }) => rest)(recorded), releaseViewArgs(TAG), 'RELEASE_VIEW_STATUS is missing'],
  ])('fails loudly on %s, naming the read-releases handoff', (_, env, args, message) => {
    const gh = recordedReleases(env);
    expect(() => gh(args)).toThrow(message);
    expect(() => gh(args)).toThrow("the read-releases job's outputs did not reach this step");
    expect(() => previousBeta(gh)).toThrow("the read-releases job's outputs did not reach this step");
  });

  test.each([
    ['0', { prevBetaTag: TAG, recovered: ['a'] }],
    ['1', { prevBetaTag: null, recovered: null }],
  ])('a recorded list status of %s behaves as the exit status it is', (listStatus, expected) => {
    expect(previousBeta(recordedReleases({ ...recorded, RELEASE_LIST_STATUS: listStatus }))).toEqual(expected);
  });

  test('a recorded view status of 1 keeps the tag and bootstraps the set', () => {
    expect(previousBeta(recordedReleases({ ...recorded, RELEASE_VIEW_STATUS: '1' }))).toEqual({ prevBetaTag: TAG, recovered: null });
  });

  test('refuses any call the job did not record', () => {
    const gh = recordedReleases(recorded);
    expect(() => gh(releaseViewArgs('v0.82.0-beta.7'))).toThrow('the read-releases job recorded no result for gh release view v0.82.0-beta.7');
    expect(() => gh(['release', 'list', '--repo', 'other/repo'])).toThrow('recorded no result');
    expect(() => recordedReleases({ ...recorded, RELEASE_VIEW_TAG: '' })(releaseViewArgs(''))).toThrow('recorded no result');
  });
});

describe('the compute-next-beta CLI takes the previous beta from the read-releases job, never from gh', () => {
  const root = mkdtempSync(join(tmpdir(), 'compute-next-beta-cli-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('./compute-next-beta.mjs', import.meta.url));

  test('a recorded previous beta that consumed every pending changeset skips the cut without running gh', () => {
    mkdirSync(join(root, '.changeset'));
    writeFileSync(
      join(root, '.changeset', 'pre.json'),
      JSON.stringify({ mode: 'pre', tag: 'beta', initialVersions: { '@inkeep/open-knowledge': '0.81.4' }, changesets: [] }),
    );
    writeFileSync(join(root, '.changeset', 'fixture-change.md'), "---\n'@inkeep/open-knowledge': patch\n---\n\nFixture change.\n");
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const tripwire = join(root, 'gh-calls.log');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$*" >> '${tripwire}'\nexit 1\n`, { mode: 0o755 });
    const out = execFileSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        RELEASE_LIST_STATUS: '0',
        RELEASE_LIST_STDOUT: 'v0.81.5-beta.0',
        RELEASE_LIST_STDERR: '',
        RELEASE_VIEW_TAG: 'v0.81.5-beta.0',
        RELEASE_VIEW_STATUS: '0',
        RELEASE_VIEW_STDOUT: 'Draft notes.\n<!-- ok-consumed-set: ["fixture-change"] -->',
      },
    });
    expect(JSON.parse(out)).toEqual({ skip: true, reason: 'no new changesets since v0.81.5-beta.0' });
    expect(existsSync(tripwire)).toBe(false);
  });
});
