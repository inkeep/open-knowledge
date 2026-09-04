import { describe, expect, test } from 'vitest';
import { computePointReleaseVersion, computeStablePromotion, evaluateAnchorGuard } from './compute-stable-version.mjs';

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
