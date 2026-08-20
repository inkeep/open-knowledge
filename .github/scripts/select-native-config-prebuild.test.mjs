import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_CANDIDATE_LIMIT,
  describeNoSelection,
  listPrebuildRuns,
  main,
  makeIsAncestor,
  makeTreeAt,
  selectPrebuildRun,
} from './select-native-config-prebuild.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = (name) => readFileSync(join(REPO_ROOT, '.github', 'workflows', name), 'utf8');

/**
 * Exact bounds of a staging step: its `- name:` up to the next sibling step, so
 * an assertion cannot run past it into a neighbouring step's shell.
 */
const stagingStep = (yaml) => {
  const rest = yaml.slice(yaml.indexOf('- name: Stage native-config prebuilt binaries'));
  const end = rest.indexOf('\n      - name: ');
  return end === -1 ? rest : rest.slice(0, end);
};

/**
 * A commit graph as a chain, oldest first, each with the native-config tree it
 * carries. Ancestry is index order; anything absent from the chain is an
 * unresolvable object, which the real git boundary reports as "not an ancestor"
 * and "no tree".
 */
const chainFixture = (chain) => {
  const index = new Map(chain.map((c, i) => [c.sha, { ...c, position: i }]));
  return {
    isAncestor: (sha, ref) => {
      const a = index.get(sha);
      const b = index.get(ref);
      return Boolean(a && b && a.position <= b.position);
    },
    treeAt: (ref) => index.get(ref)?.tree ?? null,
  };
};

// The graph that wedged v0.58.10: the release tag sits behind the newest green
// prebuild, and an older prebuild carries byte-identical native-config source.
const RELEASE_REGRESSION = chainFixture([
  { sha: '98556f27', tree: 'eb09e361' }, // 2026-07-24 prebuild — ancestor of the tag
  { sha: 'b2b06a46', tree: 'eb09e361' }, // v0.58.10's commit
  { sha: '7d5af880', tree: 'e1a1c0e4' }, // #3648 — newest prebuild, DESCENDANT of the tag
]);

const CANDIDATES_NEWEST_FIRST = [
  { databaseId: 32317026296, headSha: '7d5af880' },
  { databaseId: 30076077253, headSha: '98556f27' },
];

describe('selectPrebuildRun', () => {
  test('takes the newest ANCESTOR run, not the newest run', () => {
    expect(
      selectPrebuildRun({
        candidates: CANDIDATES_NEWEST_FIRST,
        ...RELEASE_REGRESSION,
        releaseRef: 'b2b06a46',
      }),
    ).toEqual({ runId: '30076077253', headSha: '98556f27' });
  });

  test('prefers the newest qualifying run when several are ancestors', () => {
    const graph = chainFixture([
      { sha: 'old', tree: 'T1' },
      { sha: 'newer', tree: 'T1' },
      { sha: 'release', tree: 'T1' },
    ]);
    expect(
      selectPrebuildRun({
        candidates: [
          { databaseId: 2, headSha: 'newer' },
          { databaseId: 1, headSha: 'old' },
        ],
        ...graph,
        releaseRef: 'release',
      }),
    ).toEqual({ runId: '2', headSha: 'newer' });
  });

  test('skips an ancestor whose native-config source differs from the release', () => {
    // The shape a FAILED intermediate prebuild leaves: the newest green ancestor
    // predates a native-config change the release already carries, so its
    // binaries no longer match the Rust source being shipped.
    const graph = chainFixture([
      { sha: 'stale', tree: 'T1' },
      { sha: 'release', tree: 'T2' },
    ]);
    expect(
      selectPrebuildRun({
        candidates: [{ databaseId: 1, headSha: 'stale' }],
        ...graph,
        releaseRef: 'release',
      }),
    ).toBeNull();
  });

  test('returns null when only descendants exist', () => {
    expect(
      selectPrebuildRun({
        candidates: [{ databaseId: 32317026296, headSha: '7d5af880' }],
        ...RELEASE_REGRESSION,
        releaseRef: 'b2b06a46',
      }),
    ).toBeNull();
  });

  test('returns null when the release ref has no native-config tree', () => {
    expect(
      selectPrebuildRun({
        candidates: CANDIDATES_NEWEST_FIRST,
        ...RELEASE_REGRESSION,
        releaseRef: 'unknown-commit',
      }),
    ).toBeNull();
  });

  test('skips candidates missing an id or a head sha', () => {
    expect(
      selectPrebuildRun({
        candidates: [
          { databaseId: '', headSha: '98556f27' },
          { databaseId: 7, headSha: '' },
          { databaseId: 30076077253, headSha: '98556f27' },
        ],
        ...RELEASE_REGRESSION,
        releaseRef: 'b2b06a46',
      }),
    ).toEqual({ runId: '30076077253', headSha: '98556f27' });
  });

  test('tolerates an empty candidate list', () => {
    expect(
      selectPrebuildRun({ candidates: [], ...RELEASE_REGRESSION, releaseRef: 'b2b06a46' }),
    ).toBeNull();
  });
});

describe('describeNoSelection', () => {
  test('names the newest green run so "why not that one" is answered', () => {
    const reason = describeNoSelection(CANDIDATES_NEWEST_FIRST);
    expect(reason).toContain('32317026296');
    expect(reason).toContain('7d5af880');
    expect(reason).toContain('packages/native-config');
  });

  test('says no run exists when there are none', () => {
    expect(describeNoSelection([])).toBe('no successful native-config-prebuild run on main found');
  });
});

describe('git boundary', () => {
  test('isAncestor reads a non-zero exit as "not an ancestor"', () => {
    const isAncestor = makeIsAncestor((_cmd, args) => ({
      status: args.includes('good') ? 0 : 1,
      stdout: '',
      stderr: '',
    }));
    expect(isAncestor('good', 'HEAD')).toBe(true);
    expect(isAncestor('missing', 'HEAD')).toBe(false);
  });

  test('treeAt returns null for an unresolvable path', () => {
    const treeAt = makeTreeAt(() => ({ status: 128, stdout: '', stderr: 'bad revision' }));
    expect(treeAt('HEAD')).toBeNull();
  });

  test('treeAt trims the tree object it reports', () => {
    const treeAt = makeTreeAt(() => ({ status: 0, stdout: 'eb09e361\n', stderr: '' }));
    expect(treeAt('HEAD')).toBe('eb09e361');
  });
});

describe('listPrebuildRuns', () => {
  test('keeps the supply-chain filters that scope candidates to merged main', () => {
    let seen = [];
    listPrebuildRuns({
      run: (_cmd, args) => {
        seen = args;
        return { status: 0, stdout: '[]', stderr: '' };
      },
    });
    expect(seen).toContain('--workflow=native-config-prebuild.yml');
    expect(seen).toContain('main');
    expect(seen).toContain('push');
    expect(seen).toContain('success');
    expect(seen).toContain(String(DEFAULT_CANDIDATE_LIMIT));
    expect(seen).toContain('databaseId,headSha');
  });

  test('walks back far enough to clear a native-config change', () => {
    expect(DEFAULT_CANDIDATE_LIMIT).toBeGreaterThan(1);
  });

  test('throws on an unreadable answer rather than reading it as "no runs"', () => {
    expect(() =>
      listPrebuildRuns({ run: () => ({ status: 1, stdout: '', stderr: 'rate limited' }) }),
    ).toThrow(/rate limited/);
  });
});

describe('main', () => {
  test('prints the selected run and commit, tab separated', () => {
    expect(
      main(['--release-ref', 'b2b06a46'], {
        list: () => CANDIDATES_NEWEST_FIRST,
        ...RELEASE_REGRESSION,
      }),
    ).toEqual({ ok: true, line: '30076077253\t98556f27' });
  });

  test('reports a reason instead of a selection when nothing qualifies', () => {
    const result = main(['--release-ref', 'b2b06a46'], {
      list: () => [{ databaseId: 32317026296, headSha: '7d5af880' }],
      ...RELEASE_REGRESSION,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('32317026296');
  });

  test('defaults to HEAD when no ref is given', () => {
    const graph = chainFixture([
      { sha: 'prebuild', tree: 'T1' },
      { sha: 'HEAD', tree: 'T1' },
    ]);
    expect(main([], { list: () => [{ databaseId: 9, headSha: 'prebuild' }], ...graph })).toEqual({
      ok: true,
      line: '9\tprebuild',
    });
  });
});

describe('workflow wiring', () => {
  // Both publish paths staged binaries with the same `--limit 1` bash, and both
  // wedged the same way. Ratcheted here so a future edit cannot reintroduce
  // newest-run selection in either one, or quietly drop one of them.
  for (const name of ['desktop-release.yml', 'release.yml']) {
    test(`${name} stages through the shared selector`, () => {
      const step = stagingStep(workflow(name));
      expect(step).toContain('select-native-config-prebuild.mjs');
      expect(step).not.toContain('--limit');
      expect(step).not.toContain('merge-base');
    });

    test(`${name} runs the selector from the workflow's own commit`, () => {
      // The checkout is the RELEASE ref, so a tag cut before the selector landed
      // carries no copy of it. Resolving the script from $GITHUB_SHA is what
      // makes a re-fire on such a tag run current release machinery — without
      // it the fix only reaches tags cut after it merged, and the releases it
      // exists to unblock stay blocked.
      const step = stagingStep(workflow(name));
      expect(step).toContain('$GITHUB_SHA:.github/scripts/select-native-config-prebuild.mjs');
      expect(step).toContain('cp .github/scripts/select-native-config-prebuild.mjs');
    });

    test(`${name} still splits beta degradation from stable refusal`, () => {
      const step = stagingStep(workflow(name));
      expect(step).toContain('degrade_or_fail');
      expect(step).toContain('IS_STABLE');
    });
  }
});
