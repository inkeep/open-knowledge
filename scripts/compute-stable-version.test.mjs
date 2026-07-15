import { describe, expect, test } from 'bun:test';
import { computeStablePromotion } from './compute-stable-version.mjs';

// Injected git boundary so tests need no repo. Defaults: unknown changeset bump
// types resolve to 'patch' (the patch floor), isAncestor false.
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
