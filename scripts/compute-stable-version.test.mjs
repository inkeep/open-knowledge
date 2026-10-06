import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { configureTestGitRepository } from '../test-support/configure-git-fixture.test-helper.ts';
import { loadChangesets, maxReleaseType } from './compute-next-beta.mjs';
import {
  changesetIdsFromTreePaths,
  computePointReleaseVersion,
  computeStablePromotion,
  evaluateAnchorGuard,
  gitAt,
  parseBumpVerdicts,
  recordBumpVerdicts,
  withBumpVerdicts,
} from './compute-stable-version.mjs';
import { gitCleanEnv } from './git-clean-env.mjs';

function fakeGit({ shas = {}, newestStable = '', changesets = {}, ancestor = () => false, bumps = {} } = {}) {
  return {
    revParse: (ref) => {
      if (!(ref in shas)) throw new Error(`fakeGit: no sha for ${ref}`);
      return shas[ref];
    },
    newestStableTag: () => newestStable,
    changesetIds: (sha) => changesets[sha] ?? [],
    isAncestor: (a, b) => ancestor(a, b),
    bumpTypeOf: (_sha, id) => (id in bumps ? bumps[id] : 'patch'),
  };
}

describe('computeStablePromotion', () => {
  test('single patch changeset over the latest stable -> next patch (the beta.1 -> 0.30.2 case)', () => {
    const git = fakeGit({
      shas: { 'v0.30.1-beta.1': 'B1', 'v0.30.1': 'S1' },
      newestStable: 'v0.30.1',
      changesets: { S1: ['c0'], B1: ['c0', 'c1'] },
    });
    const r = computeStablePromotion('v0.30.1-beta.1', git);
    expect(r).toMatchObject({
      skip: false,
      stableVersion: '0.30.2',
      stableTag: 'v0.30.2',
      bump: 'patch',
      deltaCount: 1,
      deltaIds: ['c1'],
    });
  });

  test('cumulative patch pile promotes as a SINGLE patch bump (beta.6 -> 0.30.2, not 0.30.7)', () => {
    const git = fakeGit({
      shas: { 'v0.30.1-beta.6': 'B6', 'v0.30.1': 'S1' },
      newestStable: 'v0.30.1',
      changesets: { S1: ['c0'], B6: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'] },
    });
    const r = computeStablePromotion('v0.30.1-beta.6', git);
    expect(r).toMatchObject({ skip: false, stableVersion: '0.30.2', bump: 'patch', deltaCount: 6 });
  });

  test('a minor changeset in the delta bumps the minor and resets patch to 0', () => {
    const git = fakeGit({
      shas: { 'v0.31.0-beta.0': 'M0', 'v0.30.1': 'S1' },
      newestStable: 'v0.30.1',
      changesets: { S1: ['c0'], M0: ['c0', 'c1', 'm1'] },
      bumps: { c1: 'patch', m1: 'minor' },
    });
    const r = computeStablePromotion('v0.31.0-beta.0', git);
    expect(r).toMatchObject({ skip: false, stableVersion: '0.31.0', bump: 'minor', deltaCount: 2 });
  });

  test('a major changeset in the delta bumps the major', () => {
    const git = fakeGit({
      shas: { 'v1.0.0-beta.0': 'MJ', 'v0.30.1': 'S1' },
      newestStable: 'v0.30.1',
      changesets: { S1: ['c0'], MJ: ['c0', 'x'] },
      bumps: { x: 'major' },
    });
    const r = computeStablePromotion('v1.0.0-beta.0', git);
    expect(r.stableVersion).toBe('1.0.0');
    expect(r.bump).toBe('major');
  });

  test('a beta already shipped in the latest stable (ancestor) is a clean no-op', () => {
    const git = fakeGit({
      shas: { 'v0.30.1-beta.0': 'S1', 'v0.30.1': 'S1' },
      newestStable: 'v0.30.1',
      ancestor: (a, b) => a === 'S1' && b === 'S1',
    });
    const r = computeStablePromotion('v0.30.1-beta.0', git);
    expect(r.skip).toBe(true);
    expect(r.reason).toMatch(/already shipped/);
  });

  test('a beta introducing no new changesets beyond the latest stable is a no-op', () => {
    const git = fakeGit({
      shas: { 'v0.30.1-beta.9': 'B9', 'v0.30.1': 'S1' },
      newestStable: 'v0.30.1',
      changesets: { S1: ['c0', 'c1'], B9: ['c0', 'c1'] },
    });
    const r = computeStablePromotion('v0.30.1-beta.9', git);
    expect(r.skip).toBe(true);
    expect(r.reason).toMatch(/no changesets beyond/);
  });

  test('bootstrap: with no prior stable, the first stable is the beta own X.Y.Z', () => {
    const git = fakeGit({ shas: { 'v0.1.0-beta.3': 'B' }, newestStable: '' });
    const r = computeStablePromotion('v0.1.0-beta.3', git);
    expect(r).toMatchObject({ skip: false, bootstrap: true, stableVersion: '0.1.0', stableTag: 'v0.1.0' });
  });

  test('double-digit patch/beta components bump correctly', () => {
    const git = fakeGit({
      shas: { 'v0.30.10-beta.12': 'B', 'v0.30.10': 'S' },
      newestStable: 'v0.30.10',
      changesets: { S: ['c0'], B: ['c0', 'c1'] },
    });
    expect(computeStablePromotion('v0.30.10-beta.12', git).stableVersion).toBe('0.30.11');
  });

  test('rejects a non-beta tag', () => {
    expect(() => computeStablePromotion('v0.30.1', fakeGit())).toThrow(/vX\.Y\.Z-beta\.N/);
    expect(() => computeStablePromotion('garbage', fakeGit())).toThrow();
  });
});

describe('evaluateAnchorGuard', () => {
  test('level anchor passes', () => {
    expect(evaluateAnchorGuard({ anchorVersion: '0.41.0', latestStableTag: 'v0.41.0' })).toMatchObject({
      ok: true,
      drift: 'none',
      anchorVersion: '0.41.0',
      latestStableVersion: '0.41.0',
    });
  });

  test('anchor behind the newest stable fails and names the pending consolidation', () => {
    const r = evaluateAnchorGuard({ anchorVersion: '0.41.0', latestStableTag: 'v0.41.1' });
    expect(r.ok).toBe(false);
    expect(r.drift).toBe('behind');
    expect(r.reason).toMatch(/main-reset consolidation is still pending/);
  });

  test('anchor ahead of the newest stable fails and is reported as a different shape', () => {
    const r = evaluateAnchorGuard({ anchorVersion: '0.42.0', latestStableTag: 'v0.41.0' });
    expect(r.ok).toBe(false);
    expect(r.drift).toBe('ahead');
    expect(r.reason).toMatch(/ahead of the newest stable/);
  });

  test('compares numerically, not lexically, across a double-digit component', () => {
    expect(evaluateAnchorGuard({ anchorVersion: '0.9.0', latestStableTag: 'v0.10.0' }).drift).toBe('behind');
    expect(evaluateAnchorGuard({ anchorVersion: '0.35.10', latestStableTag: 'v0.35.9' }).drift).toBe('ahead');
    expect(evaluateAnchorGuard({ anchorVersion: '0.35.10', latestStableTag: 'v0.35.10' }).ok).toBe(true);
  });

  test('bootstrap: no stable tag yet cannot be stale', () => {
    expect(evaluateAnchorGuard({ anchorVersion: '0.1.0', latestStableTag: '' })).toMatchObject({
      ok: true,
      drift: 'bootstrap',
      latestStableVersion: '',
    });
  });

  test('tolerates surrounding whitespace from raw git / json input', () => {
    expect(evaluateAnchorGuard({ anchorVersion: ' 0.41.0 ', latestStableTag: 'v0.41.0\n' }).ok).toBe(true);
  });

  test('a malformed anchor throws rather than reporting drift', () => {
    expect(() => evaluateAnchorGuard({ anchorVersion: '0.41', latestStableTag: 'v0.41.0' })).toThrow(
      /bare X\.Y\.Z version/,
    );
    expect(() => evaluateAnchorGuard({ anchorVersion: undefined, latestStableTag: 'v0.41.0' })).toThrow(
      /bare X\.Y\.Z version/,
    );
    expect(() => evaluateAnchorGuard({ anchorVersion: 'v0.41.0', latestStableTag: 'v0.41.0' })).toThrow(
      /bare X\.Y\.Z version/,
    );
  });

  test('a malformed stable tag throws rather than reporting drift', () => {
    expect(() => evaluateAnchorGuard({ anchorVersion: '0.41.0', latestStableTag: 'v0.41.0-beta.3' })).toThrow(
      /vX\.Y\.Z format/,
    );
    expect(() => evaluateAnchorGuard({ anchorVersion: '0.41.0', latestStableTag: 'garbage' })).toThrow(
      /vX\.Y\.Z format/,
    );
  });

  test('reports only: it never sleeps, retries, or mutates', () => {
    const before = Date.now();
    const a = evaluateAnchorGuard({ anchorVersion: '0.41.0', latestStableTag: 'v0.41.1' });
    const b = evaluateAnchorGuard({ anchorVersion: '0.41.0', latestStableTag: 'v0.41.1' });
    expect(a).toEqual(b);
    expect(Date.now() - before).toBeLessThan(500);
  });
});

describe('computePointReleaseVersion', () => {
  test('cherry-pick mode: one patch fix over the latest stable lands on the next patch', () => {
    const git = fakeGit({ changesets: { S: ['c0'], SYN: ['c0', 'fix1'] } });
    const r = computePointReleaseVersion(
      { syntheticSha: 'SYN', latestStableTag: 'v0.32.0', latestStableSha: 'S', mode: 'cherry-pick' },
      git,
    );
    expect(r).toMatchObject({
      version: '0.32.1',
      tag: 'v0.32.1',
      latestStableVersion: '0.32.0',
      bump: 'patch',
      addedIds: ['fix1'],
      removedIds: [],
    });
  });

  test('revert mode over the canonical shape: the culprit changeset leaves, nothing arrives', () => {
    const git = fakeGit({ changesets: { S: ['c0', 'bad'], SYN: ['c0'] } });
    const r = computePointReleaseVersion(
      { syntheticSha: 'SYN', latestStableTag: 'v0.32.0', latestStableSha: 'S', mode: 'revert' },
      git,
    );
    expect(r).toMatchObject({
      version: '0.32.1',
      tag: 'v0.32.1',
      bump: 'patch',
      addedIds: [],
      removedIds: ['bad'],
    });
  });

  test('revert mode reads no changeset frontmatter even when the delta is non-empty', () => {
    const git = {
      ...fakeGit({ changesets: { S: ['c0'], SYN: ['c0', 'leftover'] } }),
      bumpTypeOf: () => {
        throw new Error('revert mode must not read changeset frontmatter');
      },
    };
    const r = computePointReleaseVersion(
      { syntheticSha: 'SYN', latestStableTag: 'v0.32.0', latestStableSha: 'S', mode: 'revert' },
      git,
    );
    expect(r).toMatchObject({ version: '0.32.1', bump: 'patch', addedIds: ['leftover'] });
  });

  test('revert mode stays a patch even when the synthetic tree gained a major changeset', () => {
    const git = fakeGit({ changesets: { S: ['c0'], SYN: ['c0', 'stray'] }, bumps: { stray: 'major' } });
    const r = computePointReleaseVersion(
      { syntheticSha: 'SYN', latestStableTag: 'v0.32.0', latestStableSha: 'S', mode: 'revert' },
      git,
    );
    expect(r).toMatchObject({ version: '0.32.1', bump: 'patch', addedIds: ['stray'] });
  });

  test('cherry-pick mode takes the max bump across the added changesets', () => {
    const git = fakeGit({
      changesets: { S: ['c0'], SYN: ['c0', 'p1', 'm1'] },
      bumps: { p1: 'patch', m1: 'minor' },
    });
    const r = computePointReleaseVersion(
      { syntheticSha: 'SYN', latestStableTag: 'v0.32.4', latestStableSha: 'S', mode: 'cherry-pick' },
      git,
    );
    expect(r).toMatchObject({ version: '0.33.0', tag: 'v0.33.0', bump: 'minor', addedIds: ['p1', 'm1'] });
  });

  test('removedIds reports the changesets the stable had and the synthetic tree lost', () => {
    const git = fakeGit({ changesets: { S: ['keep', 'gone'], SYN: ['keep', 'new'] } });
    const r = computePointReleaseVersion(
      { syntheticSha: 'SYN', latestStableTag: 'v0.32.0', latestStableSha: 'S', mode: 'cherry-pick' },
      git,
    );
    expect(r.addedIds).toEqual(['new']);
    expect(r.removedIds).toEqual(['gone']);
  });

  test('an empty added delta still yields a patch bump in cherry-pick mode', () => {
    const git = fakeGit({ changesets: { S: ['c0'], SYN: ['c0'] } });
    const r = computePointReleaseVersion(
      { syntheticSha: 'SYN', latestStableTag: 'v0.32.0', latestStableSha: 'S', mode: 'cherry-pick' },
      git,
    );
    expect(r).toMatchObject({ version: '0.32.1', bump: 'patch', addedIds: [], removedIds: [] });
  });

  test('double-digit version components bump numerically', () => {
    const git = fakeGit({ changesets: { S: [], SYN: ['fix'] } });
    expect(
      computePointReleaseVersion(
        { syntheticSha: 'SYN', latestStableTag: 'v0.35.19', latestStableSha: 'S', mode: 'revert' },
        git,
      ).tag,
    ).toBe('v0.35.20');
    expect(
      computePointReleaseVersion(
        { syntheticSha: 'SYN', latestStableTag: 'v0.9.0', latestStableSha: 'S', mode: 'cherry-pick' },
        git,
      ).tag,
    ).toBe('v0.9.1');
  });

  test('a malformed or absent latest stable tag throws rather than bootstrapping', () => {
    const git = fakeGit();
    const call = (latestStableTag) =>
      computePointReleaseVersion({ syntheticSha: 'SYN', latestStableTag, latestStableSha: 'S', mode: 'revert' }, git);
    expect(() => call('')).toThrow(/vX\.Y\.Z format/);
    expect(() => call('v0.32.0-beta.4')).toThrow(/vX\.Y\.Z format/);
    expect(() => call('garbage')).toThrow(/vX\.Y\.Z format/);
    expect(() => call(undefined)).toThrow(/vX\.Y\.Z format/);
  });

  test('an unrecognized mode throws instead of defaulting to a bump rule', () => {
    const git = fakeGit({ changesets: { S: [], SYN: ['fix'] } });
    expect(() =>
      computePointReleaseVersion(
        { syntheticSha: 'SYN', latestStableTag: 'v0.32.0', latestStableSha: 'S', mode: 'revrt' },
        git,
      ),
    ).toThrow(/not one of: cherry-pick, revert/);
    expect(() =>
      computePointReleaseVersion(
        { syntheticSha: 'SYN', latestStableTag: 'v0.32.0', latestStableSha: 'S', mode: undefined },
        git,
      ),
    ).toThrow(/not one of: cherry-pick, revert/);
  });

  test('a missing commit sha on either side throws a named error', () => {
    const git = fakeGit({ changesets: { S: [], SYN: [] } });
    expect(() =>
      computePointReleaseVersion(
        { syntheticSha: '', latestStableTag: 'v0.32.0', latestStableSha: 'S', mode: 'revert' },
        git,
      ),
    ).toThrow(/synthetic commit sha/);
    expect(() =>
      computePointReleaseVersion(
        { syntheticSha: 'SYN', latestStableTag: 'v0.32.0', latestStableSha: undefined, mode: 'revert' },
        git,
      ),
    ).toThrow(/latest stable commit sha/);
  });

  test('tolerates surrounding whitespace from raw git output', () => {
    const git = fakeGit({ changesets: { S: ['c0'], SYN: ['c0', 'fix'] } });
    const r = computePointReleaseVersion(
      { syntheticSha: 'SYN\n', latestStableTag: ' v0.32.0\n', latestStableSha: ' S ', mode: 'cherry-pick' },
      git,
    );
    expect(r.tag).toBe('v0.32.1');
    expect(r.addedIds).toEqual(['fix']);
  });
});

const repos = [];

afterEach(() => {
  while (repos.length) rmSync(repos.pop(), { recursive: true, force: true });
});

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, env: gitCleanEnv(), encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
}

function committedChangesets(files, { subtree = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'stable-version-changesets-'));
  repos.push(root);
  for (const [name, body] of Object.entries(files)) {
    const target = join(root, subtree, '.changeset', name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  git(root, ['init', '-q', '-b', 'main']);
  configureTestGitRepository(root);
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'changesets']);
  return root;
}

const OK = '@inkeep/open-knowledge';
const bump = (body) => `---\n${body}\n---\n\nA change.\n`;

const disagreementsWithTheOldRawReader = {
  'quoted.md': bump(`"${OK}": "major"`),
  'trailing-comment.md': bump(`"${OK}": minor # was: major`),
  'comment-line.md': bump(`# bump: major\n"${OK}": patch`),
  'readme.md': bump(`"${OK}": major`),
  'README.md': '# Changesets\n',
  '.hidden.md': bump(`"${OK}": major`),
  'plain.md': bump(`"${OK}": patch`),
  'config.json': '{}',
};

describe('changesetIdsFromTreePaths', () => {
  test('keeps what @changesets/read keeps: top-level .md files except dotfiles and README in any case', () => {
    const paths = [
      '.changeset/README.md',
      '.changeset/readme.md',
      '.changeset/.hidden.md',
      '.changeset/config.json',
      '.changeset/wise-cats-sing.md',
      '',
    ];
    expect(changesetIdsFromTreePaths(paths)).toEqual(['wise-cats-sing']);
  });
});

describe('gitAt reads a commit\'s changesets the way Changesets reads the same tree', () => {
  test('the ids and bumps it reads at HEAD equal @changesets/read on the checkout', async () => {
    const root = committedChangesets(disagreementsWithTheOldRawReader);
    const reader = gitAt(root);
    const fromGit = Object.fromEntries(
      reader.changesetIds('HEAD').map((id) => [id, reader.bumpTypeOf('HEAD', id)]),
    );
    const fromChangesets = Object.fromEntries(
      (await loadChangesets().read(root)).map(({ id, releases }) => [id, maxReleaseType(releases)]),
    );
    expect(fromGit).toEqual(fromChangesets);
    expect(fromGit).toEqual({
      quoted: 'major',
      'trailing-comment': 'minor',
      'comment-line': 'patch',
      plain: 'patch',
    });
  });

  test('from a subtree checkout it reads the subtree\'s .changeset, as in the monorepo', () => {
    const root = committedChangesets({ 'quoted.md': bump(`"${OK}": "minor"`) }, { subtree: 'public/open-knowledge' });
    const reader = gitAt(join(root, 'public/open-knowledge'));
    expect(reader.changesetIds('HEAD')).toEqual(['quoted']);
    expect(reader.bumpTypeOf('HEAD', 'quoted')).toBe('minor');
  });

  test('a changeset Changesets cannot parse fails the read instead of counting as no bump', () => {
    const root = committedChangesets({ 'broken.md': bump(`"${OK}": Major`) });
    expect(() => gitAt(root).bumpTypeOf('HEAD', 'broken')).toThrow();
  });
});

describe('parseBumpVerdicts', () => {
  test('reads a blob-to-bump object, keeping a null bump', () => {
    expect(parseBumpVerdicts('{"aaa":"minor","bbb":null}')).toEqual(
      new Map([
        ['aaa', 'minor'],
        ['bbb', null],
      ]),
    );
  });

  test.each([
    ['', /^BUMP_VERDICTS is empty: the read-bumps job wrote no bump_verdicts output/],
    ['  \n', /^BUMP_VERDICTS is empty/],
    ['{', /^bump verdicts are not JSON/],
    ['[]', /JSON object/],
    ['null', /JSON object/],
    ['{"aaa":"huge"}', /aaa is "huge"/],
  ])('refuses %j', (raw, message) => {
    expect(() => parseBumpVerdicts(raw)).toThrow(message);
  });
});

describe('bump verdicts carry a read from one job to another by blob id', () => {
  test('a verdict recorded where the reader ran answers the same changeset where it cannot', () => {
    const root = committedChangesets({ 'quoted.md': bump(`"${OK}": "minor"`), 'plain.md': bump(`"${OK}": patch`) });
    const verdicts = new Map();
    const reading = recordBumpVerdicts(gitAt(root), verdicts);
    expect(reading.bumpTypeOf('HEAD', 'quoted')).toBe('minor');
    expect([...verdicts.values()]).toEqual(['minor']);

    const noReader = withBumpVerdicts(
      {
        ...gitAt(root),
        bumpTypeOf: () => {
          throw new Error('the Changesets reader is not installed in this job');
        },
      },
      verdicts,
    );
    expect(noReader.bumpTypeOf('HEAD', 'quoted')).toBe('minor');
    expect(() => noReader.bumpTypeOf('HEAD', 'plain')).toThrow(/no bump verdict for \.changeset\/plain\.md/);
  });
});

describe('the promote job computes the stable version with no node_modules at all', () => {
  const SCRIPTS = dirname(fileURLToPath(import.meta.url));
  const SCRIPT_FILES = ['compute-stable-version.mjs', 'compute-next-beta.mjs', 'git-clean-env.mjs'];

  function promotionFixture() {
    const root = mkdtempSync(join(tmpdir(), 'stable-version-promotion-'));
    repos.push(root);
    const commit = (name, body, tagName) => {
      mkdirSync(join(root, '.changeset'), { recursive: true });
      writeFileSync(join(root, '.changeset', name), body);
      git(root, ['add', '-A']);
      git(root, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', name]);
      git(root, ['tag', tagName]);
    };
    git(root, ['init', '-q', '-b', 'main']);
    configureTestGitRepository(root);
    commit('keep.md', bump(`"${OK}": patch`), 'v0.30.1');
    commit('new-thing.md', bump(`"${OK}": minor`), 'v0.30.2-beta.1');
    return root;
  }

  function isolatedScripts() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stable-version-no-node-modules-')));
    repos.push(dir);
    mkdirSync(join(dir, 'scripts'));
    for (const file of SCRIPT_FILES) copyFileSync(join(SCRIPTS, file), join(dir, 'scripts', file));
    return join(dir, 'scripts', 'compute-stable-version.mjs');
  }

  function run(script, cwd, env = {}) {
    const output = join(mkdtempSync(join(tmpdir(), 'stable-version-output-')), 'github-output');
    repos.push(dirname(output));
    writeFileSync(output, '');
    const { BUMP_VERDICTS: _inherited, ...base } = gitCleanEnv();
    const res = spawnSync(process.execPath, [script, 'v0.30.2-beta.1'], {
      cwd,
      encoding: 'utf8',
      env: { ...base, GITHUB_OUTPUT: output, ...env },
    });
    const outputs = Object.fromEntries(
      readFileSync(output, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => [line.split('=')[0], line.split('=').slice(1).join('=')]),
    );
    return { ...res, outputs };
  }

  test('with the reader job verdicts it writes every output the reader job wrote', () => {
    const root = promotionFixture();
    const withReader = run(join(SCRIPTS, 'compute-stable-version.mjs'), root);
    expect(withReader.status, withReader.stderr).toBe(0);
    expect(withReader.outputs.stable_tag).toBe('v0.31.0');
    expect(Object.values(JSON.parse(withReader.outputs.bump_verdicts))).toEqual(['minor']);

    const withoutReader = run(isolatedScripts(), root, { BUMP_VERDICTS: withReader.outputs.bump_verdicts });
    expect(withoutReader.status, withoutReader.stderr).toBe(0);
    const { bump_verdicts: recorded, ...promotion } = withReader.outputs;
    expect(recorded).not.toBe('{}');
    expect(withoutReader.outputs).toEqual({ ...promotion, bump_verdicts: '{}' });
  });

  test('without verdicts the same isolated copy cannot load the reader, so the run above proves it never tried', () => {
    const root = promotionFixture();
    const res = run(isolatedScripts(), root);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/@changesets\/cli/);
  });

  test('an empty BUMP_VERDICTS stops the run with an error naming the read-bumps output, and writes nothing', () => {
    const root = promotionFixture();
    const res = run(isolatedScripts(), root, { BUMP_VERDICTS: '' });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/BUMP_VERDICTS is empty: the read-bumps job wrote no bump_verdicts output/);
    expect(res.outputs).toEqual({});
  });
});
