import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { configureTestGitRepository } from '../test-support/configure-git-fixture.test-helper.ts';
import { fixedGroupOf } from './changeset-versions.mjs';
import {
  betaBase,
  extractDeltaSection,
  parseSection,
  previousBeta,
  provingRun,
  publishedStableTags,
  RELEASE_LIST_ARGS,
  recordedReleases,
  releaseViewArgs,
  renderNotes,
  STABLE_RELEASES_ARGS,
  transientPreState,
} from './compute-next-beta.mjs';
import { releasedChangesetIds } from './compute-stable-version.mjs';
import { gitCleanEnv } from './git-clean-env.mjs';

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

  test('drops headerless dependency bumps nested under a real change', () => {
    const packageDeltas = {
      app: `### Patch Changes

- Agent conversations now open the Agents panel.
  - @inkeep/open-knowledge-core@0.0.0-beta.0
  - @inkeep/open-knowledge-server@0.0.0-beta.0
`,
    };
    const notes = renderNotes({ ...baseInput, packageDeltas });
    expect(notes).toContain('- Agent conversations now open the Agents panel.');
    expect(notes).not.toContain('@inkeep/open-knowledge-core@');
    expect(notes).not.toContain('@inkeep/open-knowledge-server@');
  });

  test('keeps a nested bullet that is not a package bump', () => {
    const packageDeltas = {
      app: `### Patch Changes

- abc1234: real change
  - mention of @inkeep/open-knowledge-core in prose
`,
    };
    const notes = renderNotes({ ...baseInput, packageDeltas });
    expect(notes).toContain('mention of @inkeep/open-knowledge-core in prose');
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

const PROVED_SHA = 'c0ffee'.repeat(6) + 'c0ff';

describe('the proving Inertia run in the beta notes', () => {
  test('a run id and a 40-hex commit become one line linking the internal run it names', () => {
    expect(provingRun({ run: '39080223029', sha: PROVED_SHA })).toEqual({
      line: `Proved by internal Inertia run [39080223029](https://github.com/inkeep/agents-private/actions/runs/39080223029) at agents-private commit \`${PROVED_SHA}\`.`,
      problem: null,
    });
  });

  test('a cut with neither input, as a push or a manual dispatch is, names no run and reports nothing', () => {
    for (const given of [{}, { run: '', sha: '' }, { run: undefined, sha: undefined }])
      expect(provingRun(given)).toEqual({ line: null, problem: null });
  });

  test('an input that is not a run id or a full lowercase commit SHA names no run and says which one', () => {
    const cases = [
      [{ run: '', sha: PROVED_SHA }, /run/],
      [{ run: '123', sha: '' }, /commit/],
      [{ run: '0', sha: PROVED_SHA }, /run/],
      [{ run: '12 ', sha: PROVED_SHA }, /run/],
      [{ run: '1e3', sha: PROVED_SHA }, /run/],
      [{ run: '1'.repeat(20), sha: PROVED_SHA }, /run/],
      [{ run: '123) [x](javascript:alert(1)', sha: PROVED_SHA }, /run/],
      [{ run: '123', sha: PROVED_SHA.slice(0, 39) }, /commit/],
      [{ run: '123', sha: PROVED_SHA.toUpperCase() }, /commit/],
      [{ run: '123', sha: `${PROVED_SHA.slice(0, 38)}\`)` }, /commit/],
    ];
    for (const [given, which] of cases) {
      const result = provingRun(given);
      expect(result.line, JSON.stringify(given)).toBeNull();
      expect(result.problem, JSON.stringify(given)).toMatch(which);
    }
  });

  test('the line sits under the delta header, before the changes, and leaves the consumed-set marker last and unchanged', () => {
    const line = provingRun({ run: '42', sha: PROVED_SHA }).line;
    const input = {
      newConsumedSet: ['a', 'b'],
      prevBetaTag: 'v0.5.0-beta.6',
      newCount: 2,
      packageDeltas: { cli: '### Patch Changes\n\n- x: y\n' },
    };
    const without = renderNotes(input);
    const notes = renderNotes({ ...input, provenance: line });
    const lines = notes.split('\n');
    expect(lines[0]).toMatch(/^Delta since previous beta/);
    expect(lines.slice(1, 4)).toEqual(['', line, '']);
    expect(lines.indexOf('### Patch Changes')).toBeGreaterThan(3);
    expect(lines.at(-1)).toBe('<!-- ok-consumed-set: ["a","b"] -->');
    expect(notes.replace(`${line}\n\n`, '')).toBe(without);
    expect(without).not.toContain('Proved by');
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
    [
      'a failed list bootstraps',
      { status: 1, stdout: '', stderr: 'HTTP 502' },
      null,
      { prevBetaTag: null, recovered: null },
    ],
    ['an empty list bootstraps', ok('\n'), null, { prevBetaTag: null, recovered: null }],
    [
      'a failed view keeps the tag and bootstraps the set',
      ok(`${TAG}\n`),
      { status: 1, stdout: '', stderr: '' },
      { prevBetaTag: TAG, recovered: null },
    ],
    [
      'a body without a marker bootstraps the set',
      ok(`${TAG}\n`),
      ok(body('no marker here')),
      { prevBetaTag: TAG, recovered: null },
    ],
    [
      'a marker that is not JSON bootstraps the set',
      ok(`${TAG}\n`),
      ok(body('<!-- ok-consumed-set: [a, b] -->')),
      { prevBetaTag: TAG, recovered: null },
    ],
    [
      'a marker that is not a string array bootstraps the set',
      ok(`${TAG}\n`),
      ok(body('<!-- ok-consumed-set: [1, 2] -->')),
      { prevBetaTag: TAG, recovered: null },
    ],
    [
      'a well-formed marker is the consumed set',
      ok(`${TAG}\n`),
      ok(body('<!-- ok-consumed-set: ["a","b"] -->')),
      { prevBetaTag: TAG, recovered: ['a', 'b'] },
    ],
    [
      'a quoted tag is unquoted',
      ok(`"${TAG}"\n`),
      ok(body('<!-- ok-consumed-set: ["a"] -->')),
      { prevBetaTag: TAG, recovered: ['a'] },
    ],
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
    expect(gh(releaseViewArgs(TAG))).toEqual({
      status: 0,
      stdout: recorded.RELEASE_VIEW_STDOUT,
      stderr: '',
    });
    expect(previousBeta(gh)).toEqual({ prevBetaTag: TAG, recovered: ['a'] });
  });

  test('replays a failed list with its status and stderr', () => {
    const gh = recordedReleases({
      RELEASE_LIST_STATUS: '1',
      RELEASE_LIST_STDOUT: '',
      RELEASE_LIST_STDERR: 'HTTP 502',
    });
    expect(gh(RELEASE_LIST_ARGS)).toEqual({ status: 1, stdout: '', stderr: 'HTTP 502' });
    expect(previousBeta(gh)).toEqual({ prevBetaTag: null, recovered: null });
  });

  test.each([
    [
      'an empty list status',
      { ...recorded, RELEASE_LIST_STATUS: '' },
      RELEASE_LIST_ARGS,
      'RELEASE_LIST_STATUS is ""',
    ],
    [
      'a missing list status',
      (({ RELEASE_LIST_STATUS: _, ...rest }) => rest)(recorded),
      RELEASE_LIST_ARGS,
      'RELEASE_LIST_STATUS is missing',
    ],
    [
      'a list status that is not a number',
      { ...recorded, RELEASE_LIST_STATUS: '0\n' },
      RELEASE_LIST_ARGS,
      'RELEASE_LIST_STATUS is "0\\n"',
    ],
    [
      'an empty view status',
      { ...recorded, RELEASE_VIEW_STATUS: '' },
      releaseViewArgs(TAG),
      'RELEASE_VIEW_STATUS is ""',
    ],
    [
      'a missing view status',
      (({ RELEASE_VIEW_STATUS: _, ...rest }) => rest)(recorded),
      releaseViewArgs(TAG),
      'RELEASE_VIEW_STATUS is missing',
    ],
  ])('fails loudly on %s, naming the read-releases handoff', (_, env, args, message) => {
    const gh = recordedReleases(env);
    expect(() => gh(args)).toThrow(message);
    expect(() => gh(args)).toThrow("the read-releases job's outputs did not reach this step");
    expect(() => previousBeta(gh)).toThrow(
      "the read-releases job's outputs did not reach this step",
    );
  });

  test.each([
    ['0', { prevBetaTag: TAG, recovered: ['a'] }],
    ['1', { prevBetaTag: null, recovered: null }],
  ])('a recorded list status of %s behaves as the exit status it is', (listStatus, expected) => {
    expect(
      previousBeta(recordedReleases({ ...recorded, RELEASE_LIST_STATUS: listStatus })),
    ).toEqual(expected);
  });

  test('a recorded view status of 1 keeps the tag and bootstraps the set', () => {
    expect(previousBeta(recordedReleases({ ...recorded, RELEASE_VIEW_STATUS: '1' }))).toEqual({
      prevBetaTag: TAG,
      recovered: null,
    });
  });

  test('refuses any call the job did not record', () => {
    const gh = recordedReleases(recorded);
    expect(() => gh(releaseViewArgs('v0.82.0-beta.7'))).toThrow(
      'the read-releases job recorded no result for gh release view v0.82.0-beta.7',
    );
    expect(() => gh(['release', 'list', '--repo', 'other/repo'])).toThrow('recorded no result');
    expect(() =>
      recordedReleases({ ...recorded, RELEASE_VIEW_TAG: '' })(releaseViewArgs('')),
    ).toThrow('recorded no result');
  });
});

describe('recordedReleases replays the stable Release listing the read-releases job recorded', () => {
  const listing = '{"tag_name":"v0.86.13","draft":true}\n{"tag_name":"v0.86.12","draft":false}';

  test('answers the listing call with its status, stdout and stderr', () => {
    const gh = recordedReleases({
      STABLE_RELEASES_STATUS: '0',
      STABLE_RELEASES_STDOUT: listing,
      STABLE_RELEASES_STDERR: '',
    });
    expect(gh(STABLE_RELEASES_ARGS)).toEqual({ status: 0, stdout: listing, stderr: '' });
  });

  test('fails loudly when the listing status never reached the step', () => {
    expect(() =>
      recordedReleases({ STABLE_RELEASES_STDOUT: listing })(STABLE_RELEASES_ARGS),
    ).toThrow(
      "STABLE_RELEASES_STATUS is missing, not an exit status: the read-releases job's outputs did not reach this step",
    );
  });

  test('lists every stable Release with its draft flag, the shape the shipped-fix listing reads', () => {
    expect(STABLE_RELEASES_ARGS.slice(0, 3)).toEqual(['api', '-X', 'GET']);
    expect(STABLE_RELEASES_ARGS[3]).toMatch(/^repos\/[^/]+\/[^/]+\/releases\?per_page=100$/);
    expect(STABLE_RELEASES_ARGS).toContain('--paginate');
    expect(STABLE_RELEASES_ARGS.at(-1)).toBe(
      '.[] | select(.tag_name | test("^v[0-9]+[.][0-9]+[.][0-9]+$")) | {tag_name, draft}',
    );
  });
});

describe('publishedStableTags', () => {
  const ok = (stdout) => () => ({ status: 0, stdout, stderr: '' });

  test('reads the listing it is handed through the reader', () => {
    const seen = [];
    const tags = publishedStableTags(ok('LISTING'), (stdout) => {
      seen.push(stdout);
      return ['v0.86.12'];
    });
    expect(tags).toEqual(['v0.86.12']);
    expect(seen).toEqual(['LISTING']);
  });

  test('asks gh for exactly the stable Release listing', () => {
    const calls = [];
    publishedStableTags(
      (args) => {
        calls.push(args);
        return { status: 0, stdout: '', stderr: '' };
      },
      () => [],
    );
    expect(calls).toEqual([STABLE_RELEASES_ARGS]);
  });

  test('a failed listing is null, which counts every stable tag as released', () => {
    expect(
      publishedStableTags(
        () => ({ status: 1, stdout: '', stderr: 'HTTP 502' }),
        () => ['never'],
      ),
    ).toBeNull();
  });

  test('an unreadable listing is null rather than a throw', () => {
    expect(
      publishedStableTags(ok('not json'), () => {
        throw new Error('bad listing');
      }),
    ).toBeNull();
  });
});

const OK = '@inkeep/open-knowledge';
const changeset = (id, type = 'patch') => ({ id, releases: [{ name: OK, type }] });

function baseFor({ tags, published, commit }) {
  const git = { stableTags: () => Object.keys(tags), changesetIds: (tag) => tags[tag] ?? [] };
  const newestStableTag = Object.keys(tags).sort((a, b) =>
    b.localeCompare(a, 'en', { numeric: true }),
  )[0];
  const result = betaBase({
    changesets: commit.map(([id, type]) => changeset(id, type)),
    newestStableTag,
    releasedIds: releasedChangesetIds(git, { releasedTags: published }),
    anchorIds: new Set(tags[newestStableTag]),
  });
  return { ...result, pending: result.pending.map(({ id }) => id) };
}

describe('betaBase cadence vectors over the newest stable tag', () => {
  const base = (types) =>
    betaBase({
      changesets: types.map((type, i) => ({
        id: `c${i}`,
        releases: type ? [{ name: '@inkeep/open-knowledge', type }] : [],
      })),
      newestStableTag: 'v0.5.0',
      releasedIds: new Set(),
      anchorIds: new Set(),
    }).baseVersion;

  test('V1 — linear patches stay on one base', () => {
    expect(base(['patch'])).toBe('0.5.1');
    expect(base(['patch', 'patch'])).toBe('0.5.1');
    expect(base(['patch', 'patch', 'patch'])).toBe('0.5.1');
  });

  test('V2 — a minor mid-cycle raises the base', () => {
    expect(base(['patch', 'minor'])).toBe('0.6.0');
    expect(base(['patch', 'minor', 'patch'])).toBe('0.6.0');
  });

  test('V3 — a major dominates the whole cycle', () => {
    expect(base(['major'])).toBe('1.0.0');
    expect(base(['major', 'minor', 'patch'])).toBe('1.0.0');
  });

  test('V4 — batched minors collapse to one minor base', () => {
    expect(base(['minor', 'minor'])).toBe('0.6.0');
    expect(base(['minor', 'minor', 'patch'])).toBe('0.6.0');
  });

  test('patch floor — a cycle with no recognizable bump still advances a patch', () => {
    expect(base([])).toBe('0.5.1');
    expect(base([null])).toBe('0.5.1');
  });
});

describe('betaBase numbers a beta from the newest stable tag and the changesets no published stable holds', () => {
  test('a pending patch over the newest stable tag is its next patch', () => {
    expect(
      baseFor({ tags: { 'v0.86.13': ['a'] }, published: ['v0.86.13'], commit: [['b', 'patch']] }),
    ).toMatchObject({
      baseVersion: '0.86.14',
      maxBumpType: 'patch',
      pending: ['b'],
      beyondAnchorCount: 1,
    });
  });

  test('a pending minor is the next minor', () => {
    expect(
      baseFor({
        tags: { 'v0.86.13': ['a'] },
        published: ['v0.86.13'],
        commit: [
          ['b', 'patch'],
          ['c', 'minor'],
        ],
      }),
    ).toMatchObject({ baseVersion: '0.87.0', maxBumpType: 'minor', pending: ['b', 'c'] });
  });

  test('a consumed changeset still on main counts as released, so its minor bumps nothing', () => {
    expect(
      baseFor({
        tags: { 'v0.86.0': ['a'] },
        published: ['v0.86.0'],
        commit: [
          ['a', 'minor'],
          ['b', 'patch'],
        ],
      }),
    ).toMatchObject({ baseVersion: '0.86.1', maxBumpType: 'patch', pending: ['b'] });
  });

  test('a changeset some published stable held stays released after a revert drops it from later tags', () => {
    expect(
      baseFor({
        tags: { 'v0.85.0': ['r'], 'v0.86.0': [] },
        published: ['v0.85.0', 'v0.86.0'],
        commit: [['r', 'minor']],
      }),
    ).toMatchObject({ baseVersion: '0.86.1', pending: [] });
  });

  describe('while the newest stable tag is a draft', () => {
    const tags = { 'v0.86.12': ['x'], 'v0.86.13': ['x', 'y'] };
    const commit = [
      ['x', 'patch'],
      ['y', 'minor'],
      ['z', 'patch'],
    ];

    test('its changesets are pending for the notes but its own bump is already in its number', () => {
      expect(baseFor({ tags, published: ['v0.86.12'], commit })).toMatchObject({
        baseVersion: '0.86.14',
        maxBumpType: 'patch',
        pending: ['y', 'z'],
        beyondAnchorCount: 1,
      });
    });

    test('the base does not move when the draft publishes', () => {
      expect(baseFor({ tags, published: ['v0.86.12', 'v0.86.13'], commit })).toMatchObject({
        baseVersion: '0.86.14',
        pending: ['z'],
      });
    });

    test('a beta that holds only the draft changesets is still numbered past it', () => {
      expect(baseFor({ tags, published: ['v0.86.12'], commit: [['y', 'minor']] })).toMatchObject({
        baseVersion: '0.86.14',
        pending: ['y'],
        beyondAnchorCount: 0,
      });
    });

    test('an unreadable listing counts the draft as released', () => {
      expect(baseFor({ tags, published: null, commit })).toMatchObject({
        baseVersion: '0.86.14',
        pending: ['z'],
      });
    });
  });

  test.each([[''], ['v0.86.13-beta.2'], [undefined]])(
    'refuses %j as the newest stable tag',
    (tag) => {
      expect(() =>
        betaBase({
          changesets: [],
          newestStableTag: tag,
          releasedIds: new Set(),
          anchorIds: new Set(),
        }),
      ).toThrow(/is not a vX\.Y\.Z stable tag/);
    },
  );
});

describe('transientPreState', () => {
  test('starts every fixed-group member at the newest stable version and carries the consumed set', () => {
    const config = { fixed: [['@inkeep/open-knowledge', '@inkeep/open-knowledge-core']] };
    expect(
      transientPreState({
        fixedGroup: fixedGroupOf(config),
        anchorVersion: '0.86.13',
        consumed: ['a'],
      }),
    ).toEqual({
      mode: 'pre',
      tag: 'beta',
      initialVersions: {
        '@inkeep/open-knowledge': '0.86.13',
        '@inkeep/open-knowledge-core': '0.86.13',
      },
      changesets: ['a'],
    });
  });
});

describe('the compute-next-beta CLI numbers from the stable tags and reads only what the read-releases job recorded', () => {
  const roots = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  const script = fileURLToPath(new URL('./compute-next-beta.mjs', import.meta.url));
  const changesetsCli = join(
    fileURLToPath(new URL('..', import.meta.url)),
    'node_modules',
    '@changesets',
    'cli',
    'bin.js',
  );

  function git(cwd, args) {
    const res = spawnSync('git', args, { cwd, env: gitCleanEnv(), encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  }

  function fixture({ tags = true } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'compute-next-beta-cli-'));
    roots.push(root);
    mkdirSync(join(root, '.changeset'));
    writeFileSync(join(root, '.changeset', 'config.json'), JSON.stringify({ fixed: [[OK]] }));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fixture-root', private: true }),
    );
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    mkdirSync(join(root, 'packages', 'cli'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'cli', 'package.json'),
      JSON.stringify({ name: OK, version: '0.0.0-unknown' }),
    );
    git(root, ['init', '-q', '-b', 'main']);
    configureTestGitRepository(root);
    const commit = (name, bump, body) => {
      writeFileSync(
        join(root, '.changeset', `${name}.md`),
        `---\n'${OK}': ${bump}\n---\n\n${body}\n`,
      );
      git(root, ['add', '-A']);
      git(root, [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        'commit',
        '-q',
        '-m',
        name,
      ]);
    };
    commit('shipped', 'patch', 'Shipped in v0.86.12.');
    if (tags) git(root, ['tag', 'v0.86.12']);
    commit('drafted', 'minor', 'Drafted in v0.86.13.');
    if (tags) git(root, ['tag', 'v0.86.13']);
    commit('fixture-change', 'patch', 'A fresh fix.');
    symlinkSync(
      join(fileURLToPath(new URL('..', import.meta.url)), 'node_modules'),
      join(root, 'node_modules'),
    );
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const tripwire = join(root, 'gh-calls.log');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$*" >> '${tripwire}'\nexit 1\n`, {
      mode: 0o755,
    });
    writeFileSync(
      join(bin, 'pnpm'),
      `#!/bin/sh\n[ "$1" = exec ] && [ "$2" = changeset ] || { echo "unexpected pnpm $*" >&2; exit 97; }\nshift 2\nexec '${process.execPath}' '${changesetsCli}' "$@"\n`,
      { mode: 0o755 },
    );
    return { root, bin, tripwire };
  }

  const publishedThrough12 = {
    STABLE_RELEASES_STATUS: '0',
    STABLE_RELEASES_STDOUT:
      '{"tag_name":"v0.86.13","draft":true}\n{"tag_name":"v0.86.12","draft":false}',
    STABLE_RELEASES_STDERR: '',
  };

  const noPreviousBeta = {
    RELEASE_LIST_STATUS: '0',
    RELEASE_LIST_STDOUT: '',
    RELEASE_LIST_STDERR: '',
  };

  const previousBetaConsumed = (ids) => ({
    RELEASE_LIST_STATUS: '0',
    RELEASE_LIST_STDOUT: 'v0.86.14-beta.0',
    RELEASE_LIST_STDERR: '',
    RELEASE_VIEW_TAG: 'v0.86.14-beta.0',
    RELEASE_VIEW_STATUS: '0',
    RELEASE_VIEW_STDOUT: `Draft notes.\n<!-- ok-consumed-set: ${JSON.stringify(ids)} -->`,
  });

  function run({ root, bin }, env) {
    return spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, ...env },
    });
  }

  test('a cut while the newest stable is a draft is numbered past it and its notes keep the draft changesets', () => {
    const fx = fixture();
    const res = run(fx, { ...noPreviousBeta, ...publishedThrough12 });
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out).toMatchObject({
      skip: false,
      baseVersion: '0.86.14',
      maxBumpType: 'patch',
      newestStableTag: 'v0.86.13',
      pendingCount: 2,
    });
    expect(out.releaseNotes).toContain('- Drafted in v0.86.13.');
    expect(out.releaseNotes).toContain('- A fresh fix.');
    expect(out.releaseNotes).not.toContain('Shipped in v0.86.12.');
    expect(out.releaseNotes).toContain('<!-- ok-consumed-set: ["drafted","fixture-change"] -->');
    expect(existsSync(fx.tripwire)).toBe(false);
  });

  test('an Inertia cut names the run and commit that proved it, and a cut without them, or with a malformed one, names none', () => {
    const fx = fixture();
    const env = { ...noPreviousBeta, ...publishedThrough12 };
    const proved = run(fx, { ...env, OK_PROVED_BY_RUN: '39080223029', OK_PROVED_AT: PROVED_SHA });
    expect(proved.status, proved.stderr).toBe(0);
    const notes = JSON.parse(proved.stdout).releaseNotes;
    expect(notes).toContain(
      `Proved by internal Inertia run [39080223029](https://github.com/inkeep/agents-private/actions/runs/39080223029) at agents-private commit \`${PROVED_SHA}\`.`,
    );
    expect(notes).toMatch(/<!-- ok-consumed-set: \["drafted","fixture-change"\] -->$/);
    const plain = run(fixture(), env);
    expect(plain.status, plain.stderr).toBe(0);
    expect(JSON.parse(plain.stdout).releaseNotes).not.toContain('Proved by');
    expect(plain.stderr).not.toContain('proving');
    const malformed = run(fixture(), { ...env, OK_PROVED_BY_RUN: 'abc', OK_PROVED_AT: PROVED_SHA });
    expect(malformed.status, malformed.stderr).toBe(0);
    expect(JSON.parse(malformed.stdout).releaseNotes).not.toContain('Proved by');
    expect(malformed.stderr).toMatch(
      /::warning::compute-next-beta: .*run.*so the notes name no proving run/,
    );
  });

  test('a cut after a previous beta renders only what that beta did not consume, and carries its consumed set forward', () => {
    const fx = fixture();
    const res = run(fx, { ...previousBetaConsumed(['drafted']), ...publishedThrough12 });
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out).toMatchObject({ skip: false, baseVersion: '0.86.14', pendingCount: 1 });
    expect(out.releaseNotes).toContain('- A fresh fix.');
    expect(out.releaseNotes).not.toContain('Drafted in v0.86.13.');
    expect(out.releaseNotes).toContain('<!-- ok-consumed-set: ["drafted","fixture-change"] -->');
  });

  test('a draft newest stable keeps its changesets pending', () => {
    const fx = fixture();
    const res = run(fx, {
      ...previousBetaConsumed(['drafted', 'fixture-change']),
      ...publishedThrough12,
    });
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      skip: true,
      reason: 'no new changesets since v0.86.14-beta.0',
    });
    expect(res.stderr).toContain(
      'Beta base 0.86.14: patch over the newest stable tag v0.86.13, from 1 of 2 pending changesets',
    );
    expect(res.stderr).toContain('in the tree of one of 1 published stable tags');
    expect(existsSync(fx.tripwire)).toBe(false);
  });

  test('a failed stable listing warns and counts every stable tag as released', () => {
    const fx = fixture();
    const res = run(fx, {
      ...previousBetaConsumed(['fixture-change']),
      STABLE_RELEASES_STATUS: '1',
      STABLE_RELEASES_STDOUT: '',
      STABLE_RELEASES_STDERR: 'HTTP 502',
    });
    expect(res.status, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      skip: true,
      reason: 'no new changesets since v0.86.14-beta.0',
    });
    expect(res.stderr).toContain(
      '::warning::compute-next-beta: listing the stable Releases failed (exit 1: HTTP 502). Counting every stable tag as released',
    );
    expect(res.stderr).toContain('from 1 of 1 pending changesets');
    expect(res.stderr).toContain('in the tree of any stable tag');
    expect(existsSync(fx.tripwire)).toBe(false);
  });

  test('a checkout without stable tags refuses to number a beta', () => {
    const fx = fixture({ tags: false });
    const res = run(fx, {
      ...previousBetaConsumed([]),
      STABLE_RELEASES_STATUS: '0',
      STABLE_RELEASES_STDOUT: '',
      STABLE_RELEASES_STDERR: '',
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("'' is not a vX.Y.Z stable tag");
    expect(existsSync(fx.tripwire)).toBe(false);
  });
});
