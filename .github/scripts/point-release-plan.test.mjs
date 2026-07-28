import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  guardAnchor,
  guardDeltaMatchesFix,
  guardMainResetDeltaIds,
  guardNativeConfigProvenance,
  guardPatchOnly,
  guardRefsOnMain,
  guardTagFree,
  parseFixRefs,
  runPointRelease,
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

describe('guard codes', () => {
  test('every guard refuses with its own distinct code', () => {
    const refusals = [
      guardAnchor({ anchorVersion: '0.32.0', latestStableTag: 'v0.32.1' }),
      guardRefsOnMain({ fixRefs: ['stray'], isOnMain: membership() }),
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
    prebuildHeadSha = 'prebuild-sha',
    ancestries = [['prebuild-sha', 'synthetic-sha']],
    cherryPick,
    revert,
  } = overrides;

  const calls = { tag: 0, pushTag: 0, createRelease: 0, dispatch: 0 };
  const dispatches = [];
  const releases = [];
  const applied = [];
  const checkedOut = [];

  return {
    calls,
    dispatches,
    releases,
    applied,
    checkedOut,
    readAnchorVersion: () => anchorVersion,
    git: {
      newestStableTag: () => stableTag,
      revParse: (ref) => (ref === stableTag ? 'stable-sha' : `${ref}-sha`),
      isOnMain: (ref) => onMain.includes(ref),
      tagExists: (t) => existingTags.includes(t),
      isAncestor: (a, b) => ancestries.some(([x, y]) => x === a && y === b),
      changesetIds: (sha) => changesets[sha] ?? [],
      bumpTypeOf: (_sha, id) => bumpTypes[id] ?? 'patch',
      checkoutDetached: (sha) => checkedOut.push(sha),
      cherryPick: cherryPick ?? ((ref) => applied.push(['cherry-pick', ref])),
      revert: revert ?? ((ref) => applied.push(['revert', ref])),
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
    expect(io.calls).toEqual({ tag: 0, pushTag: 0, createRelease: 0, dispatch: 0 });
  });

  test('offers no conflict-resolution escape hatch to reach for', () => {
    const source = readFileSync(new URL('./point-release-plan.mjs', import.meta.url), 'utf8');
    // Git's merge-strategy and pick-continuation affordances, in the forms they
    // would actually appear in an argv array. Bare 'ours'/'theirs' are matched
    // quoted so ordinary prose like "now yours" does not trip the check.
    const escapes = [
      '--strategy',
      '-Xours',
      '-Xtheirs',
      "'ours'",
      "'theirs'",
      '--continue',
      '--skip',
      '--abort',
      '--no-commit',
    ];
    for (const escape of escapes) {
      expect(source).not.toContain(escape);
    }
  });

  test('rejects a mode it does not recognize rather than defaulting to cherry-pick', () => {
    const io = makeIo();
    expect(() => runPointRelease({ mode: 'rebase', fixRefs: ['bad1'], dryRun: true }, io)).toThrow(/not one of/);
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
