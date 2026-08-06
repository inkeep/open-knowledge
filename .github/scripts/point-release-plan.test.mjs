import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  deriveEntryLevelResolution,
  formatReleaseNotes,
  guardAnchor,
  guardDeltaMatchesFix,
  guardMainResetDeltaIds,
  guardNativeConfigProvenance,
  guardPatchOnly,
  guardRefsOnMain,
  guardResolvePathsAllowlisted,
  guardTagFree,
  parseFixRefs,
  parseResolvePaths,
  RESOLVABLE_PATHS,
  runPointRelease,
  verifyWorkspaceMatchesLockfile,
} from './point-release-plan.mjs';

// Build an isOnMain / tagExists boundary from a plain list. The sentinel
// 'THROW' simulates an infra failure (an unreadable ref), which must propagate
// rather than read as a clean "not on main".
const membership = (...members) => {
  const set = new Set(members);
  return (value) => {
    if (value === 'THROW') throw new Error('simulated git infra error');
    return set.has(value);
  };
};

describe('guardAnchor', () => {
  test('refuses while a stable tag is ahead of the changeset anchor', () => {
    const r = guardAnchor({ anchorVersion: '0.32.0', latestStableTag: 'v0.32.1' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('anchor-drift');
  });

  test('passes when the anchor is level with the newest stable', () => {
    const r = guardAnchor({ anchorVersion: '0.32.1', latestStableTag: 'v0.32.1' });
    expect(r).toMatchObject({ ok: true, code: null });
  });

  test('propagates a malformed anchor instead of reporting it as drift', () => {
    expect(() => guardAnchor({ anchorVersion: 'not-a-version', latestStableTag: 'v0.32.1' })).toThrow();
  });
});

describe('parseFixRefs', () => {
  test('splits on commas and whitespace, trims, and dedupes', () => {
    expect(parseFixRefs(' abc123 ,  def456\ndef456\tghi789 ')).toEqual(['abc123', 'def456', 'ghi789']);
  });

  test('throws when no ref survives parsing', () => {
    expect(() => parseFixRefs('  , ,\n ')).toThrow(/no fix ref/i);
  });

  test('throws on missing input', () => {
    expect(() => parseFixRefs(undefined)).toThrow(/no fix ref/i);
  });
});

describe('guardRefsOnMain', () => {
  test('passes when every fix ref is contained in main', () => {
    const r = guardRefsOnMain({ fixRefs: ['abc', 'def'], isOnMain: membership('abc', 'def') });
    expect(r).toMatchObject({ ok: true, code: null });
  });

  test('refuses naming every ref that is not on main', () => {
    const r = guardRefsOnMain({ fixRefs: ['abc', 'stray', 'other'], isOnMain: membership('abc') });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ref-not-on-main');
    expect(r.message).toContain('stray');
    expect(r.message).toContain('other');
  });

  test('propagates an ancestry infra error instead of reading it as not-on-main', () => {
    expect(() => guardRefsOnMain({ fixRefs: ['THROW'], isOnMain: membership() })).toThrow(/infra error/);
  });
});

describe('guardTagFree', () => {
  test('passes when the computed tag does not exist yet', () => {
    const r = guardTagFree({ tag: 'v0.32.1', tagExists: membership('v0.32.0') });
    expect(r).toMatchObject({ ok: true, code: null });
  });

  test('refuses when the computed tag is already taken', () => {
    const r = guardTagFree({ tag: 'v0.32.1', tagExists: membership('v0.32.1') });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('tag-exists');
    expect(r.message).toContain('v0.32.1');
  });

  test('propagates a tag-lookup infra error instead of reading it as a free tag', () => {
    // The direction matters more here than for the sibling guards: reading an
    // unreadable tag as "free" is what lets a run push over a tag it never
    // actually checked.
    expect(() => guardTagFree({ tag: 'THROW', tagExists: membership() })).toThrow(/infra error/);
  });
});

describe('guardDeltaMatchesFix', () => {
  test('cherry-pick passes when the added delta is exactly the fix own changesets', () => {
    const r = guardDeltaMatchesFix({
      mode: 'cherry-pick',
      addedIds: ['brave-pandas-sing', 'wise-moths-hum'],
      // Order differs from addedIds: the comparison is over sets, since the
      // pick order is not something the operator controls.
      fixChangesetIds: ['wise-moths-hum', 'brave-pandas-sing'],
    });
    expect(r).toMatchObject({ ok: true, code: null });
  });

  test('cherry-pick refuses when the delta carries a changeset the fix did not bring', () => {
    const r = guardDeltaMatchesFix({
      mode: 'cherry-pick',
      addedIds: ['brave-pandas-sing', 'unrelated-pile-work'],
      fixChangesetIds: ['brave-pandas-sing'],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('delta-mismatch');
    expect(r.message).toContain('unrelated-pile-work');
  });

  test('cherry-pick refuses when a changeset the fix brought is missing from the delta', () => {
    const r = guardDeltaMatchesFix({
      mode: 'cherry-pick',
      addedIds: [],
      fixChangesetIds: ['brave-pandas-sing'],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('delta-mismatch');
    expect(r.message).toContain('brave-pandas-sing');
  });

  test('revert passes when the revert added no changeset', () => {
    // fixChangesetIds is deliberately non-empty: the reverted commit owned a
    // changeset, and revert mode must judge the delta, not the culprit.
    const r = guardDeltaMatchesFix({
      mode: 'revert',
      addedIds: [],
      fixChangesetIds: ['brave-pandas-sing'],
    });
    expect(r).toMatchObject({ ok: true, code: null });
  });

  test('revert refuses when the delta added a changeset', () => {
    const r = guardDeltaMatchesFix({
      mode: 'revert',
      addedIds: ['brave-pandas-sing'],
      fixChangesetIds: [],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('delta-mismatch');
    expect(r.message).toContain('brave-pandas-sing');
  });
});

describe('guardPatchOnly', () => {
  test('passes on a patch bump', () => {
    expect(guardPatchOnly({ bump: 'patch' })).toMatchObject({ ok: true, code: null });
  });

  test('refuses a minor bump', () => {
    const r = guardPatchOnly({ bump: 'minor' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('bump-not-patch');
    expect(r.message).toContain('minor');
  });
});

describe('guardNativeConfigProvenance', () => {
  test('passes when the prebuild head is contained in the synthetic commit', () => {
    const r = guardNativeConfigProvenance({
      prebuildHeadSha: 'prebuild',
      syntheticSha: 'synthetic',
      isAncestor: membership('prebuild'),
    });
    expect(r).toMatchObject({ ok: true, code: null });
  });

  test('refuses when the prebuild head is not contained in the synthetic commit', () => {
    const r = guardNativeConfigProvenance({
      prebuildHeadSha: 'prebuild',
      syntheticSha: 'synthetic',
      isAncestor: membership(),
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('native-config-drift');
    expect(r.message).toContain('native-config');
  });

  test('refuses when no successful prebuild run exists to stage from', () => {
    // An absent head sha must be diagnosed as "no run to stage from", not run
    // through the ancestry check, where the real git boundary would raise an
    // infra error on an empty rev rather than answer cleanly.
    const r = guardNativeConfigProvenance({
      prebuildHeadSha: '',
      syntheticSha: 'synthetic',
      isAncestor: membership('prebuild'),
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('native-config-drift');
    expect(r.message).toMatch(/No successful native-config-prebuild run/i);
  });

  test('propagates an ancestry infra error instead of reading it as drift', () => {
    expect(() =>
      guardNativeConfigProvenance({
        prebuildHeadSha: 'THROW',
        syntheticSha: 'synthetic',
        isAncestor: membership(),
      }),
    ).toThrow(/infra error/);
  });
});

describe('guardMainResetDeltaIds', () => {
  test('passes on a non-empty delta', () => {
    expect(guardMainResetDeltaIds({ deltaIds: ['brave-pandas-sing'] })).toMatchObject({ ok: true, code: null });
  });

  test('refuses an empty array, which main-reset reads as consolidate-everything', () => {
    const r = guardMainResetDeltaIds({ deltaIds: [] });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('empty-delta-ids');
  });

  test('refuses an absent delta for the same reason', () => {
    expect(guardMainResetDeltaIds({ deltaIds: null })).toMatchObject({ ok: false, code: 'empty-delta-ids' });
  });
});

// The three-ref fixture the resolution path is built around, reduced from the
// real refusal that motivated it: between the last stable and the fix, the
// patchedDependencies block was re-sorted and gained an unrelated entry, so the
// fix's own single added line no longer has its diff context. Its patch file is
// not in the synthetic tree, which is why taking the fix's whole file is not
// merely disallowed but broken.
//
// The `overrides:` block is load-bearing, not scenery: it is the second block
// the lockfile mirrors, so without it here the overrides half of the coherence
// check would compare two empty maps and pass vacuously on every test.
const WS_STABLE = `packages:
  - 'packages/*'

overrides:
  'radix-ui': 1.4.3
  "@types/node": ^24.7.0

patchedDependencies:
  '@handlewithcare/remark-prosemirror@0.1.5': patches/@handlewithcare%2Fremark-prosemirror@0.1.5.patch
  'y-prosemirror@1.3.7': patches/y-prosemirror@1.3.7.patch
  '@pierre/trees@1.0.0-beta.4': patches/@pierre%2Ftrees@1.0.0-beta.4.patch
`;

const WS_FIX_PARENT = `packages:
  - 'packages/*'

overrides:
  'radix-ui': 1.4.3
  "@types/node": ^24.7.0

patchedDependencies:
  '@handlewithcare/remark-prosemirror@0.1.5': patches/@handlewithcare%2Fremark-prosemirror@0.1.5.patch
  '@lingui/core@6.5.0': patches/@lingui%2Fcore@6.5.0.patch
  '@pierre/trees@1.0.0-beta.4': patches/@pierre%2Ftrees@1.0.0-beta.4.patch
  'y-prosemirror@1.3.7': patches/y-prosemirror@1.3.7.patch
`;

const WS_FIX = WS_FIX_PARENT.replace(
  "  'y-prosemirror@1.3.7'",
  "  'react-resizable-panels@4.12.1': patches/react-resizable-panels@4.12.1.patch\n  'y-prosemirror@1.3.7'",
);

// pnpm writes some keys quoted and some bare in the same block, so the key
// reader has to survive both to compare the two files at all.
// Quoting deliberately differs from the workspace file on every key: pnpm
// writes each file's keys its own way, so a comparison that treated quoting as
// a difference would refuse every legitimate resolution.
const LOCK_AFTER_MERGE = `lockfileVersion: '9.0'

overrides:
  radix-ui: 1.4.3
  '@types/node': ^24.7.0

patchedDependencies:
  '@handlewithcare/remark-prosemirror@0.1.5':
    hash: aaa
    path: patches/@handlewithcare%2Fremark-prosemirror@0.1.5.patch
  '@pierre/trees@1.0.0-beta.4':
    hash: bbb
    path: patches/@pierre%2Ftrees@1.0.0-beta.4.patch
  react-resizable-panels@4.12.1:
    hash: ccc
    path: patches/react-resizable-panels@4.12.1.patch
  y-prosemirror@1.3.7:
    hash: ddd
    path: patches/y-prosemirror@1.3.7.patch

importers:
`;

describe('parseResolvePaths', () => {
  test('is empty for a blank input, so nothing is authorized by default', () => {
    expect(parseResolvePaths(undefined)).toEqual([]);
    expect(parseResolvePaths('   ')).toEqual([]);
  });

  test('splits and dedupes like the sibling list inputs', () => {
    expect(parseResolvePaths('pnpm-workspace.yaml, pnpm-workspace.yaml')).toEqual(['pnpm-workspace.yaml']);
  });
});

describe('guardResolvePathsAllowlisted', () => {
  test('passes on an empty input and says nothing is authorized', () => {
    const r = guardResolvePathsAllowlisted({ resolvePaths: [] });
    expect(r).toMatchObject({ ok: true, code: null });
    expect(r.message).toMatch(/hard-fail/i);
  });

  test('passes on an allowlisted config path', () => {
    expect(guardResolvePathsAllowlisted({ resolvePaths: ['pnpm-workspace.yaml'] })).toMatchObject({
      ok: true,
    });
  });

  test('refuses a source path, naming every offender', () => {
    const r = guardResolvePathsAllowlisted({
      resolvePaths: ['pnpm-workspace.yaml', 'packages/app/src/main.tsx', '.github/workflows/release.yml'],
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('resolve-path-not-allowlisted');
    expect(r.message).toContain('packages/app/src/main.tsx');
    expect(r.message).toContain('.github/workflows/release.yml');
  });

  test('refuses a glob or a parent directory rather than expanding it', () => {
    expect(guardResolvePathsAllowlisted({ resolvePaths: ['*'] }).code).toBe('resolve-path-not-allowlisted');
    expect(guardResolvePathsAllowlisted({ resolvePaths: ['.'] }).code).toBe('resolve-path-not-allowlisted');
  });
});

describe('deriveEntryLevelResolution', () => {
  test('rebuilds the stable file with the entry the fix added and nothing else', () => {
    const { resolved, added, removed } = deriveEntryLevelResolution({
      base: WS_STABLE,
      fixBefore: WS_FIX_PARENT,
      fixAfter: WS_FIX,
    });
    expect(added).toEqual(["  'react-resizable-panels@4.12.1': patches/react-resizable-panels@4.12.1.patch"]);
    expect(removed).toEqual([]);
    // The entry the fix brought is registered; the unrelated entry that drifted
    // in alongside it is NOT, because its patch file is not in this tree.
    expect(resolved).toContain("'react-resizable-panels@4.12.1': patches/react-resizable-panels@4.12.1.patch");
    expect(resolved).not.toContain('@lingui/core');
    // The stable's own order is preserved rather than replaced by the fix's.
    expect(resolved).toBe(
      `${WS_STABLE}  'react-resizable-panels@4.12.1': patches/react-resizable-panels@4.12.1.patch\n`,
    );
  });

  test('lands the entry inside its block, not at the end of the file', () => {
    // The block happens to be last in the reduced fixture, so pin the general
    // case too: with a section after it, the entry still goes in the block.
    const withTail = `${WS_STABLE}\nonlyBuiltDependencies:\n  - electron\n`;
    const { resolved } = deriveEntryLevelResolution({
      base: withTail,
      fixBefore: WS_FIX_PARENT,
      fixAfter: WS_FIX,
    });
    const lines = resolved.split('\n');
    const at = lines.findIndex((l) => l.includes('react-resizable-panels'));
    expect(at).toBeGreaterThan(lines.indexOf('patchedDependencies:'));
    expect(at).toBeLessThan(lines.indexOf('onlyBuiltDependencies:'));
  });

  test('carries a removal through as a deletion of that exact entry', () => {
    const fixAfter = WS_FIX_PARENT.replace("  'y-prosemirror@1.3.7': patches/y-prosemirror@1.3.7.patch\n", '');
    const { resolved, added, removed } = deriveEntryLevelResolution({
      base: WS_STABLE,
      fixBefore: WS_FIX_PARENT,
      fixAfter,
    });
    expect(added).toEqual([]);
    expect(removed).toEqual(["  'y-prosemirror@1.3.7': patches/y-prosemirror@1.3.7.patch"]);
    expect(resolved).not.toContain('y-prosemirror');
    expect(resolved).toContain('@pierre/trees');
  });

  test('refuses when the stable already declares the added key with a different value', () => {
    // Not an addition at all: the fix and the stable disagree about one entry,
    // and re-deriving would silently pick a side.
    const base = WS_STABLE.replace(
      "  '@pierre/trees@1.0.0-beta.4': patches/@pierre%2Ftrees@1.0.0-beta.4.patch",
      "  'react-resizable-panels@4.12.1': patches/react-resizable-panels@4.11.0.patch",
    );
    expect(() => deriveEntryLevelResolution({ base, fixBefore: WS_FIX_PARENT, fixAfter: WS_FIX })).toThrow(
      /CHANGES that entry/,
    );
  });

  test('refuses when the block the entry belongs to is not in the stable file', () => {
    const base = "packages:\n  - 'packages/*'\n";
    expect(() => deriveEntryLevelResolution({ base, fixBefore: WS_FIX_PARENT, fixAfter: WS_FIX })).toThrow(
      /not in the last stable/,
    );
  });

  test.each([
    ['a new top-level key', `${WS_FIX_PARENT}ignorePatchFailures: false\n`],
    // A comment and a sequence item both have no key to place them by, so
    // deriving one would mean guessing what it was attached to.
    ['a comment inside the block', WS_FIX_PARENT.replace('patchedDependencies:\n', 'patchedDependencies:\n  # note\n')],
    ['a sequence item', WS_FIX_PARENT.replace("  - 'packages/*'\n", "  - 'packages/*'\n  - 'apps/*'\n")],
  ])('refuses %s, which is not an indented mapping entry', (_label, fixAfter) => {
    expect(() => deriveEntryLevelResolution({ base: WS_STABLE, fixBefore: WS_FIX_PARENT, fixAfter })).toThrow(
      /not an indented mapping entry/,
    );
  });

  test('refuses to remove a line the stable no longer has', () => {
    const fixAfter = WS_FIX_PARENT.replace("  '@lingui/core@6.5.0': patches/@lingui%2Fcore@6.5.0.patch\n", '');
    expect(() => deriveEntryLevelResolution({ base: WS_STABLE, fixBefore: WS_FIX_PARENT, fixAfter })).toThrow(
      /does not appear exactly once in the last stable/,
    );
  });

  test('refuses when the fix does not touch the file at all', () => {
    expect(() =>
      deriveEntryLevelResolution({
        base: WS_STABLE,
        fixBefore: WS_FIX_PARENT,
        fixAfter: WS_FIX_PARENT,
      }),
    ).toThrow(/makes no line-level change/);
  });
});

describe('verifyWorkspaceMatchesLockfile', () => {
  const resolved = deriveEntryLevelResolution({
    base: WS_STABLE,
    fixBefore: WS_FIX_PARENT,
    fixAfter: WS_FIX,
  }).resolved;

  test('passes when the re-derived registrations match the merged lockfile', () => {
    const note = verifyWorkspaceMatchesLockfile({
      resolved,
      readWorktreeFile: () => LOCK_AFTER_MERGE,
    });
    expect(note).toMatch(/agrees with the lockfile/);
    expect(note).toContain('patchedDependencies');
  });

  test('catches taking the fix file wholesale, which registers a patch that is not in the tree', () => {
    expect(() =>
      verifyWorkspaceMatchesLockfile({
        resolved: WS_FIX,
        readWorktreeFile: () => LOCK_AFTER_MERGE,
      }),
    ).toThrow(/@lingui\/core/);
  });

  test('catches keeping the stable file wholesale, which drops the fix own registration', () => {
    expect(() =>
      verifyWorkspaceMatchesLockfile({
        resolved: WS_STABLE,
        readWorktreeFile: () => LOCK_AFTER_MERGE,
      }),
    ).toThrow(/react-resizable-panels/);
  });

  test('reads through the two files differing quote styles rather than calling them a mismatch', () => {
    // The same override is `"@types/node"` in the workspace file and
    // `'@types/node'` in the lockfile. Treating that as a difference would
    // refuse every legitimate resolution.
    expect(verifyWorkspaceMatchesLockfile({ resolved, readWorktreeFile: () => LOCK_AFTER_MERGE })).toContain(
      'overrides',
    );
  });

  test('checks overrides too, not just patch registrations', () => {
    // pnpm hard-fails a frozen install on an overrides mismatch exactly as it
    // does on patchedDependencies. Checking only the latter would verify an
    // overrides re-derivation with a comparison that passes vacuously.
    const withExtraOverride = resolved.replace("  'radix-ui': 1.4.3", "  'radix-ui': 1.4.3\n  'left-pad': 1.3.0");
    expect(() =>
      verifyWorkspaceMatchesLockfile({ resolved: withExtraOverride, readWorktreeFile: () => LOCK_AFTER_MERGE }),
    ).toThrow(/overrides.*left-pad/s);
  });

  test('catches an overrides VALUE that drifted, not just a missing key', () => {
    const bumped = resolved.replace("  'radix-ui': 1.4.3", "  'radix-ui': 1.9.9");
    expect(() =>
      verifyWorkspaceMatchesLockfile({ resolved: bumped, readWorktreeFile: () => LOCK_AFTER_MERGE }),
    ).toThrow(/radix-ui: 1\.9\.9/);
  });

  test('fails closed when the lockfile cannot be read', () => {
    expect(() =>
      verifyWorkspaceMatchesLockfile({
        resolved,
        readWorktreeFile: () => {
          throw new Error('ENOENT');
        },
      }),
    ).toThrow();
  });
});

describe('guard codes', () => {
  test('every guard refuses with its own distinct code', () => {
    const refusals = [
      guardAnchor({ anchorVersion: '0.32.0', latestStableTag: 'v0.32.1' }),
      guardRefsOnMain({ fixRefs: ['stray'], isOnMain: membership() }),
      guardResolvePathsAllowlisted({ resolvePaths: ['packages/app/src/main.tsx'] }),
      guardTagFree({ tag: 'v0.32.1', tagExists: membership('v0.32.1') }),
      guardDeltaMatchesFix({ mode: 'revert', addedIds: ['x'], fixChangesetIds: [] }),
      guardPatchOnly({ bump: 'major' }),
      guardNativeConfigProvenance({ prebuildHeadSha: 'p', syntheticSha: 's', isAncestor: membership() }),
      guardMainResetDeltaIds({ deltaIds: [] }),
    ];
    expect(refusals.every((r) => r.ok === false)).toBe(true);
    const codes = refusals.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    // Every refusal carries an operator-readable message, not just a code.
    expect(refusals.every((r) => typeof r.message === 'string' && r.message.length > 0)).toBe(true);
  });
});

// A whole io boundary built from a fixture. Every remote-mutating member counts
// its calls, which is what makes "a dry run touches nothing" a real assertion
// rather than a claim.
function makeIo(overrides = {}) {
  const {
    stableTag = 'v0.32.0',
    anchorVersion = '0.32.0',
    onMain = ['bad1', 'fix1'],
    existingTags = ['v0.32.0'],
    changesets = { 'stable-sha': ['keep-a'], 'synthetic-sha': ['keep-a'] },
    bumpTypes = {},
    changesetContents = {},
    prebuildHeadSha = 'prebuild-sha',
    ancestries = [['prebuild-sha', 'synthetic-sha']],
    cherryPick,
    revert,
    // Conflict simulation. `conflicts` is the unmerged path list git would
    // report; `files` is a `${rev}:${path}` -> contents map the derivation and
    // its coherence check read from.
    conflicts = [],
    files = {},
    worktree = {},
  } = overrides;

  const calls = { tag: 0, pushTag: 0, createRelease: 0, dispatch: 0 };
  const dispatches = [];
  const releases = [];
  const applied = [];
  const checkedOut = [];
  const staged = [];
  const continued = [];
  const written = {};
  const reads = [];

  return {
    calls,
    dispatches,
    releases,
    applied,
    checkedOut,
    staged,
    continued,
    written,
    reads,
    // Exposed so a multi-pick test can advance it the way git does: each pick
    // merges the lockfile again, so the arbiter a derivation is checked against
    // is the one for the pick being applied, not the end state.
    worktree,
    fs: {
      readWorktreeFile: (path) => {
        if (!(path in worktree)) throw new Error(`no worktree file ${path}`);
        return worktree[path];
      },
      // Recorded where `fileAt('HEAD', …)` will find it, so a second ref in the
      // same run derives against what the first one produced. A fake that kept
      // returning the tag's copy would let a regression that silently reverts
      // the first derivation pass.
      writeWorktreeFile: (path, content) => {
        written[path] = content;
      },
    },
    readAnchorVersion: () => anchorVersion,
    git: {
      newestStableTag: () => stableTag,
      revParse: (ref) => (ref === stableTag ? 'stable-sha' : `${ref}-sha`),
      isOnMain: (ref) => onMain.includes(ref),
      tagExists: (t) => existingTags.includes(t),
      isAncestor: (a, b) => ancestries.some(([x, y]) => x === a && y === b),
      changesetIds: (sha) => changesets[sha] ?? [],
      bumpTypeOf: (_sha, id) => bumpTypes[id] ?? 'patch',
      changesetContent: (_sha, id) => {
        const content = changesetContents[id];
        if (content === undefined) throw new Error(`no changeset content for ${id}`);
        return content;
      },
      checkoutDetached: (sha) => checkedOut.push(sha),
      cherryPick: cherryPick ?? ((ref) => applied.push(['cherry-pick', ref])),
      revert: revert ?? ((ref) => applied.push(['revert', ref])),
      conflictedPaths: () => [...conflicts],
      fileAt: (rev, path) => {
        const key = `${rev}:${path}`;
        reads.push(key);
        // HEAD tracks the working tree once something has been written to it,
        // which is what makes a second ref derive against the first's output.
        if (rev === 'HEAD' && path in written) return written[path];
        if (!(key in files)) throw new Error(`fatal: path '${path}' does not exist in '${rev}'`);
        return files[key];
      },
      stage: (path) => staged.push(path),
      continueApply: (mode) => {
        continued.push(mode);
        applied.push([mode, 'continued']);
      },
      headSha: () => 'synthetic-sha',
      tag: () => calls.tag++,
      pushTag: () => calls.pushTag++,
    },
    gh: {
      newestNativeConfigPrebuildHeadSha: () => prebuildHeadSha,
      createRelease: (r) => {
        calls.createRelease++;
        releases.push(r);
      },
      dispatch: (d) => {
        calls.dispatch++;
        dispatches.push(d);
      },
    },
  };
}

// A cherry-pick that collides in the workspace config and nowhere else, which
// is the shape the resolution path exists for.
const conflictIo = (overrides = {}) =>
  makeIo({
    cherryPick: () => {
      throw new Error('CONFLICT (content): Merge conflict in pnpm-workspace.yaml');
    },
    conflicts: ['pnpm-workspace.yaml'],
    files: {
      'HEAD:pnpm-workspace.yaml': WS_STABLE,
      'fix1^:pnpm-workspace.yaml': WS_FIX_PARENT,
      'fix1:pnpm-workspace.yaml': WS_FIX,
    },
    worktree: { 'pnpm-lock.yaml': LOCK_AFTER_MERGE },
    changesets: {
      'stable-sha': ['keep-a'],
      'synthetic-sha': ['keep-a', 'shiny-fix'],
      fix1: ['keep-a', 'shiny-fix'],
      'fix1^': ['keep-a'],
    },
    ...overrides,
  });

describe('runPointRelease dry run', () => {
  test('revert mode over v0.32.0 plans v0.32.1 and touches nothing remote', () => {
    const io = makeIo();
    const plan = runPointRelease({ mode: 'revert', fixRefs: ['bad1'], dryRun: true }, io);
    expect(plan.tag).toBe('v0.32.1');
    expect(io.calls).toEqual({ tag: 0, pushTag: 0, createRelease: 0, dispatch: 0 });
  });

  test('cherry-pick mode reports the delta and touches nothing remote', () => {
    const io = makeIo({
      changesets: {
        'stable-sha': ['keep-a'],
        'synthetic-sha': ['keep-a', 'shiny-fix'],
        fix1: ['keep-a', 'shiny-fix'],
        'fix1^': ['keep-a'],
      },
    });
    const plan = runPointRelease({ mode: 'cherry-pick', fixRefs: ['fix1'], dryRun: true }, io);
    expect(plan.tag).toBe('v0.32.1');
    expect(plan.addedIds).toEqual(['shiny-fix']);
    expect(io.calls).toEqual({ tag: 0, pushTag: 0, createRelease: 0, dispatch: 0 });
  });

  test('cherry-pick with two refs unions their changesets without double-counting', () => {
    // fix2 lands on top of fix1, so reading each ref against its own parent
    // reports fix1-cs twice. The delta must still be the union, or a legitimate
    // two-commit point release refuses with a bogus delta mismatch.
    const io = makeIo({
      onMain: ['fix1', 'fix2'],
      changesets: {
        'stable-sha': ['keep-a'],
        'synthetic-sha': ['keep-a', 'fix1-cs', 'fix2-cs'],
        fix1: ['keep-a', 'fix1-cs'],
        'fix1^': ['keep-a'],
        fix2: ['keep-a', 'fix1-cs', 'fix2-cs'],
        'fix2^': ['keep-a', 'fix1-cs'],
      },
    });
    const plan = runPointRelease({ mode: 'cherry-pick', fixRefs: ['fix1', 'fix2'], dryRun: true }, io);
    expect(plan.addedIds).toEqual(['fix1-cs', 'fix2-cs']);
    expect(io.calls).toEqual({ tag: 0, pushTag: 0, createRelease: 0, dispatch: 0 });
  });

  test('throws when the clone holds no stable tag to patch over', () => {
    // A point release is defined as a patch over an existing stable. With no
    // stable tag there is no base to compute against, and proceeding would cut
    // a first-ever release out of this lane rather than out of the normal path.
    const io = makeIo({ stableTag: '' });
    expect(() => runPointRelease({ mode: 'revert', fixRefs: ['bad1'], dryRun: true }, io)).toThrow(
      /patch over an existing stable/,
    );
    // Refusing before touching the clone is the point: the throw sits ahead of
    // the detach, so a run with no stable to patch over leaves no working state
    // behind for the next one to trip over.
    expect(io.checkedOut).toEqual([]);
    expect(io.applied).toEqual([]);
  });

  test('the plan carries what an operator needs to decide whether to arm a real run', () => {
    const io = makeIo();
    const plan = runPointRelease({ mode: 'revert', fixRefs: ['bad1'], dryRun: true }, io);
    expect(plan.latestStableTag).toBe('v0.32.0');
    expect(plan.fixRefs).toEqual([{ ref: 'bad1', sha: 'bad1-sha', onMain: true }]);
    expect(plan.version).toBe('0.32.1');
    expect(plan.syntheticTree).toMatchObject({ sha: 'synthetic-sha', changesetCount: 1 });
    expect(plan.guards.length).toBeGreaterThanOrEqual(6);
  });

  test('the synthetic commit is still built, so a dry run finds out whether the fix applies', () => {
    const io = makeIo();
    runPointRelease({ mode: 'revert', fixRefs: ['bad1'], dryRun: true }, io);
    expect(io.checkedOut).toEqual(['stable-sha']);
    expect(io.applied).toEqual([['revert', 'bad1']]);
  });
});

describe('runPointRelease cascade', () => {
  const cherryPickIo = () =>
    makeIo({
      changesets: {
        'stable-sha': ['keep-a'],
        'synthetic-sha': ['keep-a', 'shiny-fix'],
        fix1: ['keep-a', 'shiny-fix'],
        'fix1^': ['keep-a'],
      },
    });

  test('dispatches the cascade payloads in the shapes the existing workflows read', () => {
    const io = cherryPickIo();
    runPointRelease(
      {
        mode: 'cherry-pick',
        fixRefs: ['fix1'],
        dryRun: false,
        dispatchedBy: 'https://run/1',
        selfRepo: 'inkeep/open-knowledge',
      },
      io,
    );
    // No publish-stable here. desktop-release.yml fires it once the DMG it
    // builds has passed the smoke gate, so dispatching it from this lane too
    // would both double-publish and move npm `latest` ahead of the gate.
    expect(io.dispatches).toEqual([
      {
        repo: 'inkeep/open-knowledge',
        eventType: 'desktop-release',
        clientPayload: { release_tag: 'v0.32.1', ref: 'v0.32.1', dispatched_by: 'https://run/1' },
      },
      {
        repo: 'inkeep/agents-private',
        eventType: 'main-reset',
        clientPayload: { stable_version: '0.32.1', delta_ids: ['shiny-fix'], dispatched_by: 'https://run/1' },
      },
    ]);
  });

  test('tags the synthetic commit and creates the Release as a draft', () => {
    const io = cherryPickIo();
    runPointRelease({ mode: 'cherry-pick', fixRefs: ['fix1'], dryRun: false }, io);
    expect(io.calls).toMatchObject({ tag: 1, pushTag: 1, createRelease: 1 });
    expect(io.releases[0]).toMatchObject({ tag: 'v0.32.1', targetSha: 'synthetic-sha', draft: true });
  });

  test('the release notes quote each added changeset the way a stable body does', () => {
    const io = makeIo({
      changesets: {
        'stable-sha': ['keep-a'],
        'synthetic-sha': ['keep-a', 'shiny-fix'],
        fix1: ['keep-a', 'shiny-fix'],
        'fix1^': ['keep-a'],
      },
      changesetContents: {
        'shiny-fix':
          '---\n"@inkeep/open-knowledge": patch\n---\n\nChips no longer balloon into ovals.\nSecond line of the note.\n',
      },
    });
    runPointRelease({ mode: 'cherry-pick', fixRefs: ['fix1'], dryRun: false }, io);
    const notes = io.releases[0].notes;
    expect(notes).toContain('### Patch Changes');
    expect(notes).toContain('- Chips no longer balloon into ovals.\n  Second line of the note.');
    expect(notes).not.toContain('Changesets added:');
  });

  test('the release notes leave the assembly mode out of the announced body', () => {
    // Slack and Discord inline this body verbatim, and how the operator
    // assembled the stable is not something a reader of the announcement acts
    // on. The workflow run summary keeps the mode for the audit trail.
    const picked = cherryPickIo();
    runPointRelease({ mode: 'cherry-pick', fixRefs: ['fix1'], dryRun: false }, picked);
    expect(picked.releases[0].notes).not.toMatch(/^Mode:/m);
    expect(picked.releases[0].notes).not.toContain('cherry-pick');

    const reverted = makeIo();
    runPointRelease({ mode: 'revert', fixRefs: ['bad1'], dryRun: false }, reverted);
    expect(reverted.releases[0].notes).not.toMatch(/^Mode:/m);
    expect(reverted.releases[0].notes).not.toContain('revert');
  });

  test('an unreadable changeset degrades its notes entry to the id rather than refusing', () => {
    const io = makeIo({
      changesets: {
        'stable-sha': ['keep-a'],
        'synthetic-sha': ['keep-a', 'shiny-fix'],
        fix1: ['keep-a', 'shiny-fix'],
        'fix1^': ['keep-a'],
      },
    });
    runPointRelease({ mode: 'cherry-pick', fixRefs: ['fix1'], dryRun: false }, io);
    expect(io.calls.createRelease).toBe(1);
    expect(io.releases[0].notes).toContain('Changesets added: shiny-fix');
    expect(io.releases[0].notes).not.toContain('### Patch Changes');
  });

  test('a dry run previews the exact release notes without touching anything remote', () => {
    const io = makeIo({
      changesets: {
        'stable-sha': ['keep-a'],
        'synthetic-sha': ['keep-a', 'shiny-fix'],
        fix1: ['keep-a', 'shiny-fix'],
        'fix1^': ['keep-a'],
      },
      changesetContents: {
        'shiny-fix': '---\n"@inkeep/open-knowledge": patch\n---\n\nChips no longer balloon into ovals.\n',
      },
    });
    const plan = runPointRelease({ mode: 'cherry-pick', fixRefs: ['fix1'], dryRun: true }, io);
    expect(plan.releaseNotes).toContain('### Patch Changes');
    expect(plan.releaseNotes).toContain('- Chips no longer balloon into ovals.');
    expect(io.calls).toEqual({ tag: 0, pushTag: 0, createRelease: 0, dispatch: 0 });
  });

  test('revert with no named delta skips main-reset and names both follow-ups', () => {
    const io = makeIo();
    const plan = runPointRelease({ mode: 'revert', fixRefs: ['bad1'], dryRun: false }, io);
    expect(plan.mainReset).toMatchObject({ dispatch: false, skipReason: 'no-delta-to-forward' });
    expect(io.dispatches.map((d) => d.eventType)).toEqual(['desktop-release']);
    expect(io.dispatches.every((d) => d.clientPayload.delta_ids === undefined)).toBe(true);
    const warning = plan.warnings.join(' ');
    expect(warning).toMatch(/on main/i);
    expect(warning).toMatch(/anchor advances/i);
  });

  test('revert forwards the changeset the operator landed to represent it', () => {
    const io = makeIo();
    runPointRelease({ mode: 'revert', fixRefs: ['bad1'], anchorDeltaIds: '["undo-bad"]', dryRun: false }, io);
    const mainReset = io.dispatches.find((d) => d.eventType === 'main-reset');
    expect(mainReset.clientPayload.delta_ids).toEqual(['undo-bad']);
  });

  test('refuses when the operator names a delta that parses to nothing', () => {
    const io = makeIo();
    let refusal;
    try {
      runPointRelease({ mode: 'revert', fixRefs: ['bad1'], anchorDeltaIds: '[]', dryRun: false }, io);
    } catch (err) {
      refusal = err;
    }
    expect(refusal?.code).toBe('empty-delta-ids');
    expect(io.calls).toEqual({ tag: 0, pushTag: 0, createRelease: 0, dispatch: 0 });
  });

  test('skips main-reset when the cross-repo bridge App is absent, without failing the run', () => {
    const io = cherryPickIo();
    const plan = runPointRelease({ mode: 'cherry-pick', fixRefs: ['fix1'], dryRun: false, bridgeConfigured: false }, io);
    expect(plan.mainReset).toMatchObject({ dispatch: false, skipReason: 'bridge-not-configured' });
    expect(io.dispatches.map((d) => d.eventType)).toEqual(['desktop-release']);
    expect(plan.warnings.join(' ')).toContain('shiny-fix');
  });

  test('a cascade failure after the tag is pushed marks the error with the pushed tag', () => {
    // The marker is what lets main() say "this half-shipped, a re-run will not
    // clear it" instead of surfacing a bare API error. Nothing else observes it,
    // so without this test a refactor could drop it silently.
    const io = cherryPickIo();
    io.gh.createRelease = () => {
      throw new Error('gh API 503');
    };

    let caught;
    try {
      runPointRelease({ mode: 'cherry-pick', fixRefs: ['fix1'], dryRun: false }, io);
    } catch (err) {
      caught = err;
    }

    expect(caught?.pushedTag).toBe('v0.32.1');
    expect(caught?.message).toContain('gh API 503');
    // Pins the try boundary as much as the marker: the tag push must have
    // happened OUTSIDE the guarded block, or the state this annotation warns
    // about would not exist and the message would be a lie.
    expect(io.calls.tag).toBe(1);
    expect(io.calls.pushTag).toBe(1);
  });
});

describe('runPointRelease refusals', () => {
  const cases = [
    ['anchor-drift', { anchorVersion: '0.31.0' }, { mode: 'revert', fixRefs: ['bad1'] }],
    ['ref-not-on-main', { onMain: [] }, { mode: 'revert', fixRefs: ['bad1'] }],
    ['tag-exists', { existingTags: ['v0.32.0', 'v0.32.1'] }, { mode: 'revert', fixRefs: ['bad1'] }],
    [
      'delta-mismatch',
      { changesets: { 'stable-sha': ['keep-a'], 'synthetic-sha': ['keep-a', 'sneaky'] } },
      { mode: 'revert', fixRefs: ['bad1'] },
    ],
    [
      'bump-not-patch',
      {
        bumpTypes: { 'shiny-fix': 'minor' },
        changesets: {
          'stable-sha': ['keep-a'],
          'synthetic-sha': ['keep-a', 'shiny-fix'],
          fix1: ['keep-a', 'shiny-fix'],
          'fix1^': ['keep-a'],
        },
      },
      { mode: 'cherry-pick', fixRefs: ['fix1'] },
    ],
    ['native-config-drift', { ancestries: [] }, { mode: 'revert', fixRefs: ['bad1'] }],
  ];

  test.each(cases)('refuses with %s and mutates nothing, even in a real run', (code, ioOpts, runOpts) => {
    const io = makeIo(ioOpts);
    let refusal;
    try {
      runPointRelease({ ...runOpts, dryRun: false }, io);
    } catch (err) {
      refusal = err;
    }
    expect(refusal?.code).toBe(code);
    expect(refusal?.message).toBeTruthy();
    expect(io.calls).toEqual({ tag: 0, pushTag: 0, createRelease: 0, dispatch: 0 });
  });

  test('a failing anchor guard stops before the synthetic commit is even built', () => {
    const io = makeIo({ anchorVersion: '0.31.0' });
    expect(() => runPointRelease({ mode: 'revert', fixRefs: ['bad1'], dryRun: false }, io)).toThrow();
    expect(io.checkedOut).toEqual([]);
    expect(io.applied).toEqual([]);
  });

  test.each([
    ['cherry-pick', 'cherryPick'],
    ['revert', 'revert'],
  ])('a %s conflict is a hard fail', (mode, member) => {
    const io = makeIo({
      [member]: () => {
        throw new Error('CONFLICT (content): Merge conflict in packages/cli/src/index.ts');
      },
      conflicts: ['packages/cli/src/index.ts'],
      changesets: {
        'stable-sha': ['keep-a'],
        'synthetic-sha': ['keep-a', 'shiny-fix'],
        fix1: ['keep-a', 'shiny-fix'],
        'fix1^': ['keep-a'],
      },
    });
    let refusal;
    try {
      runPointRelease({ mode, fixRefs: [mode === 'revert' ? 'bad1' : 'fix1'], dryRun: false }, io);
    } catch (err) {
      refusal = err;
    }
    expect(refusal?.code).toBe('apply-conflict');
    expect(refusal?.message).toMatch(/conflict/i);
    expect(refusal?.message).toContain('packages/cli/src/index.ts');
    expect(io.calls).toEqual({ tag: 0, pushTag: 0, createRelease: 0, dispatch: 0 });
  });

  test('an apply that fails without leaving a conflict propagates as undecided, not as a refusal', () => {
    // An empty pick, a dirty tree, a git spawn failure. None of them says the
    // fix depends on something between the last stable and now, so calling them
    // `apply-conflict` would send the operator to pick a different commit over
    // a problem that is not about the commit — and would exit 2 ("you have
    // something to do") where the honest answer is exit 1 ("re-run it").
    const io = makeIo({
      cherryPick: () => {
        throw new Error('error: git failed to execute (exit null)');
      },
      conflicts: [],
    });
    let caught;
    try {
      runPointRelease({ mode: 'cherry-pick', fixRefs: ['fix1'], dryRun: false }, io);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.code).toBeUndefined();
    expect(caught?.message).toContain('git failed to execute');
    expect(io.calls).toEqual({ tag: 0, pushTag: 0, createRelease: 0, dispatch: 0 });
  });

  test('a conflict in an allowlisted path still hard-fails when it was not authorized', () => {
    // The default is unchanged, and the refusal is where the operator learns
    // the option exists at all — naming a path is a decision made after seeing
    // a dry run refuse, not something to reach for pre-emptively.
    const io = conflictIo();
    let refusal;
    try {
      runPointRelease({ mode: 'cherry-pick', fixRefs: ['fix1'], dryRun: false }, io);
    } catch (err) {
      refusal = err;
    }
    expect(refusal?.code).toBe('apply-conflict');
    expect(refusal.message).toContain('resolve_paths=pnpm-workspace.yaml');
    expect(io.written).toEqual({});
    expect(io.staged).toEqual([]);
    expect(io.continued).toEqual([]);
    expect(io.calls).toEqual({ tag: 0, pushTag: 0, createRelease: 0, dispatch: 0 });
  });

  test('still names the eligible config path in the hint when source conflicted too', () => {
    // The shape an operator actually meets: a pick that collides in source AND
    // in the config registry, with nothing authorized. The refusal has to list
    // both paths (so they can see the source conflict is the real blocker) and
    // still name the one that would be resolvable on its own. An `eligible`
    // filter written against the wrong list would drop the hint here while the
    // single-path test above kept passing.
    const io = conflictIo({ conflicts: ['pnpm-workspace.yaml', 'packages/cli/src/index.ts'] });
    let refusal;
    try {
      runPointRelease({ mode: 'cherry-pick', fixRefs: ['fix1'], dryRun: false }, io);
    } catch (err) {
      refusal = err;
    }
    expect(refusal?.code).toBe('apply-conflict');
    expect(refusal.message).toContain('packages/cli/src/index.ts');
    expect(refusal.message).toContain('-f resolve_paths=pnpm-workspace.yaml');
    // The hint names only the allowlisted path, never the source one.
    expect(refusal.message).not.toContain('resolve_paths=pnpm-workspace.yaml,packages');
    expect(io.written).toEqual({});
  });

  test('offers no side-picking escape hatch to reach for', () => {
    const source = readFileSync(new URL('./point-release-plan.mjs', import.meta.url), 'utf8');
    // Git's merge-strategy and pick-skipping affordances, in the forms they
    // would actually appear in an argv array. Bare 'ours'/'theirs' are matched
    // quoted so ordinary prose like "now yours" does not trip the check.
    // Both of those sides are not merely disallowed by policy: taking either
    // one wholesale for pnpm-workspace.yaml produces a tree whose patch
    // registrations or overrides disagree with the lockfile, which cannot
    // install at all.
    const escapes = ['--strategy', '-Xours', '-Xtheirs', "'ours'", "'theirs'", '--skip', '--abort', '--no-commit'];
    for (const escape of escapes) {
      expect(source).not.toContain(escape);
    }
  });

  test('the resolvable-path allowlist admits config registries only, never behavior', () => {
    // The allowlist is the whole security boundary of the resolution path: it
    // is what keeps `resolve_paths` from becoming a general "resolve my
    // conflicts" switch aimed at whatever an operator types. Growing it is a
    // deliberate act that should fail this test first.
    expect(RESOLVABLE_PATHS).toEqual(['pnpm-workspace.yaml']);
    for (const path of RESOLVABLE_PATHS) {
      expect(path.endsWith('.yaml') || path.endsWith('.json')).toBe(true);
      expect(path).not.toMatch(/^(packages|src|scripts|patches|\.github)\//);
    }
  });

  test('rejects a mode it does not recognize rather than defaulting to cherry-pick', () => {
    const io = makeIo();
    expect(() => runPointRelease({ mode: 'rebase', fixRefs: ['bad1'], dryRun: true }, io)).toThrow(/not one of/);
    expect(io.applied).toEqual([]);
  });
});

describe('runPointRelease with an authorized config path', () => {
  const authorized = ['pnpm-workspace.yaml'];

  test('re-derives the file, finishes the pick, and ships', () => {
    const io = conflictIo();
    const plan = runPointRelease(
      { mode: 'cherry-pick', fixRefs: ['fix1'], resolvePaths: authorized, dryRun: false },
      io,
    );

    expect(io.written['pnpm-workspace.yaml']).toContain("'react-resizable-panels@4.12.1'");
    expect(io.written['pnpm-workspace.yaml']).not.toContain('@lingui/core');
    expect(io.staged).toEqual(['pnpm-workspace.yaml']);
    expect(io.continued).toEqual(['cherry-pick']);
    expect(io.calls).toMatchObject({ tag: 1, pushTag: 1, createRelease: 1 });

    expect(plan.resolvedPaths).toHaveLength(1);
    expect(plan.resolvedPaths[0]).toMatchObject({
      ref: 'fix1',
      path: 'pnpm-workspace.yaml',
      removed: [],
    });
  });

  test('the derivation reads the stable from HEAD, not from the tag', () => {
    const io = conflictIo();
    runPointRelease({ mode: 'cherry-pick', fixRefs: ['fix1'], resolvePaths: authorized, dryRun: true }, io);
    expect(io.reads).toContain('HEAD:pnpm-workspace.yaml');
    expect(io.reads).not.toContain('stable-sha:pnpm-workspace.yaml');
  });

  test('a second conflicting ref derives against the first one output, not back onto the tag', () => {
    // The invariant reading from HEAD exists for. Both refs register a patch
    // and both conflict; if the second derived from the tag again it would
    // silently drop the first ref's entry, and the release would ship claiming
    // a fix whose registration is not in the tree.
    const withBoth = LOCK_AFTER_MERGE.replace(
      '  y-prosemirror@1.3.7:',
      `  second-fix@2.0.0:
    hash: eee
    path: patches/second-fix@2.0.0.patch
  y-prosemirror@1.3.7:`,
    );
    const io = conflictIo({
      onMain: ['fix1', 'fix2'],
      files: {
        'HEAD:pnpm-workspace.yaml': WS_STABLE,
        'fix1^:pnpm-workspace.yaml': WS_FIX_PARENT,
        'fix1:pnpm-workspace.yaml': WS_FIX,
        'fix2^:pnpm-workspace.yaml': WS_FIX,
        'fix2:pnpm-workspace.yaml': WS_FIX.replace(
          "  'y-prosemirror@1.3.7'",
          "  'second-fix@2.0.0': patches/second-fix@2.0.0.patch\n  'y-prosemirror@1.3.7'",
        ),
      },
      changesets: {
        'stable-sha': ['keep-a'],
        'synthetic-sha': ['keep-a', 'fix1-cs', 'fix2-cs'],
        fix1: ['keep-a', 'fix1-cs'],
        'fix1^': ['keep-a'],
        fix2: ['keep-a', 'fix1-cs', 'fix2-cs'],
        'fix2^': ['keep-a', 'fix1-cs'],
      },
    });

    // git re-merges the lockfile on each pick, so the second derivation is
    // checked against a lockfile that now carries both entries.
    const finishPick = io.git.continueApply;
    io.git.continueApply = (mode) => {
      io.worktree['pnpm-lock.yaml'] = withBoth;
      finishPick(mode);
    };

    const plan = runPointRelease(
      { mode: 'cherry-pick', fixRefs: ['fix1', 'fix2'], resolvePaths: authorized, dryRun: true },
      io,
    );

    expect(plan.resolvedPaths).toHaveLength(2);
    expect(io.continued).toEqual(['cherry-pick', 'cherry-pick']);
    // Both entries survive, and the second derivation did not revert the first.
    const final = io.written['pnpm-workspace.yaml'];
    expect(final).toContain("'react-resizable-panels@4.12.1'");
    expect(final).toContain("'second-fix@2.0.0'");
    expect(final).not.toContain('@lingui/core');
  });

  test('a missing path at a fix revision refuses as not-derivable', () => {
    const io = conflictIo({
      files: { 'HEAD:pnpm-workspace.yaml': WS_STABLE, 'fix1^:pnpm-workspace.yaml': WS_FIX_PARENT },
    });
    let refusal;
    try {
      runPointRelease({ mode: 'cherry-pick', fixRefs: ['fix1'], resolvePaths: authorized, dryRun: false }, io);
    } catch (err) {
      refusal = err;
    }
    expect(refusal?.code).toBe('resolve-not-derivable');
    expect(io.written).toEqual({});
    expect(io.staged).toEqual([]);
    expect(io.continued).toEqual([]);
    expect(io.calls).toEqual({ tag: 0, pushTag: 0, createRelease: 0, dispatch: 0 });
  });

  test('git other not-in-this-tree wording also refuses as not-derivable', () => {
    // git says "does not exist in" for a path absent from the tree and "exists
    // on disk, but not in" when the working tree has it and the tree-ish does
    // not. Both mean the same thing here; only the first arrives through the
    // fake's own message, so without this the second alternative could be
    // dropped in a refactor with the suite still green.
    const io = conflictIo();
    const real = io.git.fileAt;
    io.git.fileAt = (rev, path) => {
      if (rev === 'fix1') throw new Error(`fatal: path '${path}' exists on disk, but not in 'fix1'`);
      return real(rev, path);
    };
    let refusal;
    try {
      runPointRelease({ mode: 'cherry-pick', fixRefs: ['fix1'], resolvePaths: authorized, dryRun: false }, io);
    } catch (err) {
      refusal = err;
    }
    expect(refusal?.code).toBe('resolve-not-derivable');
    expect(io.written).toEqual({});
    expect(io.continued).toEqual([]);
  });

  test('an unreadable revision propagates as undecided rather than posing as a structural finding', () => {
    // A spawn failure is not the fix creating or deleting the file. Dressing it
    // as `resolve-not-derivable` would tell the operator to go find a
    // disagreement between the fix and the stable that does not exist.
    const io = conflictIo();
    io.git.fileAt = () => {
      throw new Error('git show HEAD:pnpm-workspace.yaml failed (exit null): spawn ENOMEM');
    };
    let caught;
    try {
      runPointRelease({ mode: 'cherry-pick', fixRefs: ['fix1'], resolvePaths: authorized, dryRun: false }, io);
    } catch (err) {
      caught = err;
    }
    expect(caught?.code).toBeUndefined();
    expect(caught?.message).toContain('ENOMEM');
    expect(io.written).toEqual({});
    expect(io.continued).toEqual([]);
  });

  test('revert mode reads the fix two sides swapped, so it removes the entry', () => {
    const io = conflictIo({
      revert: () => {
        throw new Error('CONFLICT (content): Merge conflict in pnpm-workspace.yaml');
      },
      changesets: { 'stable-sha': ['keep-a'], 'synthetic-sha': ['keep-a'] },
      files: {
        'HEAD:pnpm-workspace.yaml': WS_STABLE,
        'bad1:pnpm-workspace.yaml': WS_FIX_PARENT,
        'bad1^:pnpm-workspace.yaml': WS_FIX_PARENT.replace(
          "  '@pierre/trees@1.0.0-beta.4': patches/@pierre%2Ftrees@1.0.0-beta.4.patch\n",
          '',
        ),
      },
      worktree: {
        'pnpm-lock.yaml': `lockfileVersion: '9.0'

overrides:
  radix-ui: 1.4.3
  '@types/node': ^24.7.0

patchedDependencies:
  '@handlewithcare/remark-prosemirror@0.1.5':
    hash: aaa
    path: patches/@handlewithcare%2Fremark-prosemirror@0.1.5.patch
  y-prosemirror@1.3.7:
    hash: ddd
    path: patches/y-prosemirror@1.3.7.patch

importers:
`,
      },
    });
    runPointRelease({ mode: 'revert', fixRefs: ['bad1'], resolvePaths: authorized, dryRun: false }, io);
    expect(io.written['pnpm-workspace.yaml']).not.toContain('@pierre/trees');
    expect(io.written['pnpm-workspace.yaml']).toContain('y-prosemirror');
    expect(io.continued).toEqual(['revert']);
  });

  test('a dry run performs the resolution and still touches nothing remote', () => {
    // The whole point of authorizing a path is to see what it produces before
    // arming, so the derivation has to run on the dry pass too.
    const io = conflictIo();
    const plan = runPointRelease(
      { mode: 'cherry-pick', fixRefs: ['fix1'], resolvePaths: authorized, dryRun: true },
      io,
    );
    expect(io.written['pnpm-workspace.yaml']).toContain("'react-resizable-panels@4.12.1'");
    expect(plan.resolvedPaths[0].added).toEqual([
      "  'react-resizable-panels@4.12.1': patches/react-resizable-panels@4.12.1.patch",
    ]);
    expect(io.calls).toEqual({ tag: 0, pushTag: 0, createRelease: 0, dispatch: 0 });
  });

  test('says so loudly, in the guard trail and as a warning', () => {
    const io = conflictIo();
    const plan = runPointRelease(
      { mode: 'cherry-pick', fixRefs: ['fix1'], resolvePaths: authorized, dryRun: true },
      io,
    );
    expect(plan.guards.some((g) => g.message.includes('Re-derived pnpm-workspace.yaml'))).toBe(true);
    const warning = plan.warnings.join(' ');
    expect(warning).toContain('did not apply cleanly');
    expect(warning).toContain('react-resizable-panels@4.12.1');
  });

  test('authorizing one path does not license a second, unauthorized one', () => {
    const io = conflictIo({ conflicts: ['pnpm-workspace.yaml', 'packages/app/src/main.tsx'] });
    let refusal;
    try {
      runPointRelease({ mode: 'cherry-pick', fixRefs: ['fix1'], resolvePaths: authorized, dryRun: false }, io);
    } catch (err) {
      refusal = err;
    }
    expect(refusal?.code).toBe('apply-conflict');
    expect(refusal.message).toContain('packages/app/src/main.tsx');
    expect(io.written).toEqual({});
    expect(io.continued).toEqual([]);
  });

  test('refuses when the re-derived file disagrees with the merged lockfile', () => {
    // The lockfile is the independent arbiter: git merged it from the same two
    // sides with no help from this code, so a mismatch means the derivation is
    // wrong, and a frozen install would fail after the tag already existed.
    const io = conflictIo({
      worktree: {
        'pnpm-lock.yaml': LOCK_AFTER_MERGE.replace(/ {2}react-resizable-panels@4\.12\.1:\n.*\n.*\n/, ''),
      },
    });
    let refusal;
    try {
      runPointRelease({ mode: 'cherry-pick', fixRefs: ['fix1'], resolvePaths: authorized, dryRun: false }, io);
    } catch (err) {
      refusal = err;
    }
    expect(refusal?.code).toBe('resolve-incoherent');
    expect(io.written).toEqual({});
    expect(io.continued).toEqual([]);
    expect(io.calls).toEqual({ tag: 0, pushTag: 0, createRelease: 0, dispatch: 0 });
  });

  test('refuses before the pick when the named path is not allowlisted', () => {
    const io = conflictIo();
    let refusal;
    try {
      runPointRelease(
        {
          mode: 'cherry-pick',
          fixRefs: ['fix1'],
          resolvePaths: ['packages/app/src/main.tsx'],
          dryRun: false,
        },
        io,
      );
    } catch (err) {
      refusal = err;
    }
    expect(refusal?.code).toBe('resolve-path-not-allowlisted');
    // Ahead of the detach, so an over-broad input costs a second and leaves no
    // working state behind.
    expect(io.checkedOut).toEqual([]);
    expect(io.applied).toEqual([]);
  });
});

// The workflow and this script are two files that have to agree on a set of
// literal names: the env vars the workflow sets and the script reads, and the
// step outputs the script writes and the workflow reads back. Nothing at runtime
// catches a rename on either side — a mistyped env name degrades to a dry run
// that still reports success, and a mistyped output name prints an empty summary
// — so the agreement is pinned here, the one place both files can be read
// together.
describe('point-release.yml contract with this script', () => {
  const workflow = readFileSync(new URL('../workflows/point-release.yml', import.meta.url), 'utf8');
  const source = readFileSync(new URL('./point-release-plan.mjs', import.meta.url), 'utf8');

  // Just the step that runs the script. Bounded at the next step so a name the
  // summary step happens to set cannot stand in for one this step forgot.
  const stepStart = workflow.indexOf('- name: Run the point release');
  const runStep = workflow.slice(stepStart, workflow.indexOf('\n      - name:', stepStart + 1));
  const provided = new Set([...runStep.matchAll(/^ {10}([A-Z][A-Z0-9_]*): /gm)].map((m) => m[1]));

  test('runs this script with every environment variable it reads', () => {
    expect(runStep).toContain('node .github/scripts/point-release-plan.mjs');
    expect(provided.size).toBeGreaterThan(0);

    // Supplied by the Actions runtime itself, never by an env: block.
    const fromRunner = new Set(['GITHUB_REPOSITORY', 'GITHUB_OUTPUT']);
    const read = [...source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]);
    expect(read.length).toBeGreaterThan(0);

    expect([...new Set(read)].filter((name) => !provided.has(name) && !fromRunner.has(name))).toEqual([]);
  });

  test('reads back only step outputs this script writes', () => {
    const outputBlock = source.slice(source.indexOf('if (process.env.GITHUB_OUTPUT)'));
    const emitted = new Set([...outputBlock.matchAll(/`([a-z_]+)=\$\{/g)].map((m) => m[1]));
    expect(emitted.size).toBeGreaterThan(0);

    const consumed = [...new Set([...workflow.matchAll(/steps\.plan\.outputs\.([a-z_]+)/g)].map((m) => m[1]))];
    expect(consumed.length).toBeGreaterThan(0);

    expect(consumed.filter((name) => !emitted.has(name))).toEqual([]);
  });

  test('defaults to a dry run and passes that default through to the script', () => {
    const inputStart = workflow.indexOf('      dry_run:');
    const input = workflow.slice(inputStart, workflow.indexOf('\n      dispatched_by:', inputStart));
    expect(input).toContain('type: boolean');
    expect(input).toContain('default: true');

    // The script arms a real run only on the literal string 'false', so the
    // wiring has to be the input itself and not a constant or a fallback that
    // could resolve to 'false' on an unattended path.
    expect(runStep).toMatch(/DRY_RUN: \$\{\{ inputs\.dry_run \}\}/);
    expect(source).toContain("process.env.DRY_RUN !== 'false'");
  });
});

describe('formatReleaseNotes "Applied" line', () => {
  const SHA = '896d38001a123ce9cf05808249d2f12894402850';
  const appliedLine = (fixRefs) =>
    formatReleaseNotes({
      latestStableTag: 'v0.48.2',
      mode: 'cherry-pick',
      fixRefs,
      changesetEntries: [],
      addedIds: [],
      removedIds: [],
    })
      .split('\n')
      .find((l) => l.startsWith('Applied:'));

  test('a ref that IS its sha prints the hash once, not twice', () => {
    // The bug lane dispatches full SHAs, so ref === sha and the old
    // `ref (sha)` shape rendered the same 40 characters twice in every
    // point-release announcement that lane produced.
    expect(appliedLine([{ ref: SHA, sha: SHA }])).toBe(`Applied: ${SHA}`);
  });

  test('a NAMED ref still shows what it resolved to', () => {
    // The parenthetical earns its place when the reader cannot resolve the
    // ref themselves; dropping it there would lose real information.
    expect(appliedLine([{ ref: 'v0.47.1', sha: SHA }])).toBe(`Applied: v0.47.1 (${SHA})`);
  });

  test('a mixed batch keeps each form', () => {
    const other = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    expect(
      appliedLine([
        { ref: SHA, sha: SHA },
        { ref: 'hotfix-tag', sha: other },
      ]),
    ).toBe(`Applied: ${SHA}, hotfix-tag (${other})`);
  });
});
