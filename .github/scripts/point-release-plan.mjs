#!/usr/bin/env node
/**
 * Preconditions for the point-release lane: the checks that decide whether
 * `lastStable + one fix` may be tagged and published as the new `latest`.
 *
 * Why they are predicates in a module rather than steps in the workflow. Every
 * one of them must hold BEFORE a tag exists, because the cascade they gate is
 * not reversible: once the tag is pushed and the GitHub Release is created, a
 * downstream refusal leaves a half-shipped state (a stable tag users can see,
 * no npm publish) on the exact channel this lane exists to repair. Written as
 * pure functions over an injected boundary, each one can be proven to refuse in
 * a unit test with no repo, no tags, and no network, which is the only way to
 * have any confidence in a path that is exercised a handful of times a year and
 * always under time pressure.
 *
 * Each guard returns `{ ok, code, message }` and every refusing `code` is
 * distinct, so an operator reading a failed run learns which precondition broke
 * rather than that "the point release failed".
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  computePointReleaseVersion,
  evaluateAnchorGuard,
  readAnchorVersion,
  realGit,
  runGit,
} from '../../scripts/compute-stable-version.mjs';

function refuse(code, message) {
  return { ok: false, code, message };
}

function pass(message) {
  return { ok: true, code: null, message };
}

/**
 * Is the changeset anchor still level with the newest stable tag?
 *
 * Delegates wholly to `evaluateAnchorGuard`, which owns the drift comparison
 * for every version-computing path; a second implementation here would drift
 * from it and disagree about the same repo state. This wrapper only adapts its
 * verdict to the guard shape.
 *
 * A refusal is final for this run. The lane holds the shared release-cadence
 * lock, so waiting out a pending main-reset here would block every beta cut and
 * promotion that the reset itself has to travel through, which is the deadlock
 * `evaluateAnchorGuard`'s contract exists to prevent.
 */
export function guardAnchor({ anchorVersion, latestStableTag }) {
  const verdict = evaluateAnchorGuard({ anchorVersion, latestStableTag });
  if (!verdict.ok) {
    return refuse(
      'anchor-drift',
      `${verdict.reason} Refusing rather than waiting: this lane holds the release-cadence lock, ` +
        'and the consolidation that clears the drift needs it. Re-run once the anchor is level.',
    );
  }
  return pass(verdict.reason);
}

/**
 * Split the operator's `fix_refs` input into individual refs.
 *
 * Commas and whitespace are both accepted because the input arrives from a
 * `workflow_dispatch` text box, where an operator pasting two SHAs separates
 * them with whichever they reach for first. Duplicates are collapsed rather
 * than applied twice: a ref repeated by a copy-paste slip would otherwise
 * cherry-pick cleanly the first time and hard-fail as an empty pick the second,
 * which reads like a conflict rather than like the typo it is.
 *
 * An input that parses to nothing throws instead of returning `[]`. Zero refs
 * would otherwise build a synthetic commit identical to the last stable and cut
 * a release containing no change at all.
 */
export function parseFixRefs(raw) {
  const refs = splitList(raw);
  if (refs.length === 0) {
    throw new Error(`no fix ref found in '${raw ?? ''}' (expected one or more commit SHAs, comma or space separated)`);
  }
  return refs;
}

/**
 * Split the operator's `anchor_delta_ids` input into changeset ids.
 *
 * Unlike `parseFixRefs` this returns an empty list rather than throwing: the
 * input is optional, and "the operator named nothing" is a decision the caller
 * makes (skip the main-reset dispatch), not an error.
 *
 * JSON array punctuation is stripped so an operator can paste a prior run's
 * `delta_ids` output verbatim. `["a","b"]` and `a, b` are the same list;
 * changeset ids are word-shaped, so nothing legitimate is lost.
 */
export function parseDeltaIds(raw) {
  return splitList(raw);
}

function splitList(raw) {
  const items = [];
  for (const piece of String(raw ?? '').split(/[\s,[\]"']+/)) {
    const item = piece.trim();
    if (item !== '' && !items.includes(item)) items.push(item);
  }
  return items;
}

/**
 * Is every fix ref already contained in the public repo's `main`?
 *
 * A point release ships ahead of the soak, so its content must still be code
 * that landed through the normal review path. A ref that is not on `main` is
 * either a typo or an attempt to ship unreviewed work straight to the default
 * install channel, and this lane is the one place where that would not be
 * caught downstream.
 *
 * Every offender is named, not just the first: an operator who mistyped two of
 * three refs should learn that in one run rather than one refusal at a time.
 * `isOnMain` is injected and any throw propagates, because an unreadable ref is
 * an infra failure and silently reading it as "not on main" would refuse a
 * legitimate release with a message pointing at the wrong problem.
 */
export function guardRefsOnMain({ fixRefs, isOnMain }) {
  const offenders = fixRefs.filter((ref) => !isOnMain(ref));
  if (offenders.length > 0) {
    return refuse(
      'ref-not-on-main',
      `Not contained in main: ${offenders.join(', ')}. A point release may only ship commits that ` +
        'already landed on main through review; check for a typo, or land the fix first.',
    );
  }
  return pass(`All ${fixRefs.length} fix ref(s) are contained in main.`);
}

/**
 * Is the computed tag still free?
 *
 * An occupied tag means the version arithmetic landed on a release that already
 * exists, which happens when a concurrent promotion won the race between the
 * version being computed and this run reaching the push. Pushing anyway either
 * fails at the remote or, worse, moves a tag users have already installed from.
 */
export function guardTagFree({ tag, tagExists }) {
  if (tagExists(tag)) {
    return refuse(
      'tag-exists',
      `Tag ${tag} already exists. Either another release reached this version first, in which case ` +
        're-run so the version is recomputed against the current stable, or a prior run of this lane ' +
        'pushed the tag and then failed before finishing its cascade, in which case see RELEASES.md, ' +
        '"Recovery: a point release failed partway" — that state needs the tag removed, not a re-run.',
    );
  }
  return pass(`Tag ${tag} is free.`);
}

/**
 * Does the synthetic commit's changeset delta contain exactly the applied fix
 * and nothing else?
 *
 * This is the check that the release is actually isolated from the unsoaked
 * pile. The version arithmetic upstream is a set difference against the last
 * stable, so anything that leaked into the synthetic tree, an unrelated
 * changeset dragged along by an over-broad ref, is indistinguishable from the
 * fix at that layer and would ship unsoaked work under a patch bump.
 *
 * `fixChangesetIds` is the union of the changesets each fix ref introduced on
 * its own, so the comparison is over sets: pick order is git's, not the
 * operator's, and ordering carries no meaning here.
 *
 * Revert mode expects an EMPTY delta and ignores `fixChangesetIds`. A revert
 * restores shipped behavior and adds no changeset; if reverting produced one,
 * the operator named a ref that adds work rather than removing it.
 */
export function guardDeltaMatchesFix({ mode, addedIds, fixChangesetIds }) {
  if (mode === 'revert') {
    if (addedIds.length > 0) {
      return refuse(
        'delta-mismatch',
        `Revert mode added changesets: ${addedIds.join(', ')}. A revert removes work and must add none; ` +
          'the named ref probably is not the commit that introduced the bug.',
      );
    }
    return pass('Revert added no changeset, as expected.');
  }

  const expected = new Set(fixChangesetIds);
  const actual = new Set(addedIds);
  const unexpected = [...actual].filter((id) => !expected.has(id));
  const missing = [...expected].filter((id) => !actual.has(id));
  if (unexpected.length > 0 || missing.length > 0) {
    const parts = [];
    if (unexpected.length > 0) parts.push(`unrelated changesets came along: ${unexpected.join(', ')}`);
    if (missing.length > 0) parts.push(`the fix's own changesets are absent: ${missing.join(', ')}`);
    return refuse(
      'delta-mismatch',
      `The synthetic commit's changeset delta is not exactly the picked fix (${parts.join('; ')}). ` +
        'Shipping it would carry unsoaked work onto the default install channel.',
    );
  }
  return pass(`Delta is exactly the picked fix (${addedIds.length} changeset(s)).`);
}

/**
 * Is this release a patch?
 *
 * A point release exists to ship one self-contained fix over the current
 * stable, and it deliberately skips the soak. A minor or major bump means the
 * delta carries a feature or a break, which is the pile's work and belongs in
 * the normal promotion path where it gets soaked.
 */
export function guardPatchOnly({ bump }) {
  if (bump !== 'patch') {
    return refuse(
      'bump-not-patch',
      `Computed bump is '${bump}', not 'patch'. This lane skips the soak, so it only ships patches; ` +
        'promote through the normal stable path instead.',
    );
  }
  return pass('Computed bump is a patch.');
}

/**
 * Would the npm publish survive its native-config provenance check?
 *
 * The publish workflow stages prebuilt native binaries from the newest
 * successful prebuild run on `main` and, on the stable path only, HARD-FAILS
 * when that run's head commit is not an ancestor of the commit being released.
 * The synthetic commit is built on the last stable, so it does not contain any
 * main commit that landed after it, and a native-config change on `main` since
 * the last stable puts the newest prebuild out of reach.
 *
 * The reason to check it here is ordering, not novelty: that failure happens
 * after the tag and the GitHub Release already exist, leaving a version users
 * can see with nothing published behind it, on the exact channel this lane is
 * supposed to be repairing. Checking the same condition before anything is
 * created turns it into a clean refusal.
 *
 * An absent head sha refuses for the same reason. No successful prebuild run
 * means the publish has nothing to stage and hard-fails one branch earlier in
 * the same step.
 */
export function guardNativeConfigProvenance({ prebuildHeadSha, syntheticSha, isAncestor }) {
  const head = String(prebuildHeadSha ?? '').trim();
  if (head === '') {
    return refuse(
      'native-config-drift',
      'No successful native-config-prebuild run found on main. The stable publish stages its native ' +
        'binaries from that run and refuses without them, so this release would fail after tagging.',
    );
  }
  if (!isAncestor(head, syntheticSha)) {
    return refuse(
      'native-config-drift',
      `The newest native-config-prebuild commit (${head}) is not contained in the synthetic commit, so ` +
        'packages/native-config changed on main after the last stable. The stable publish would refuse ' +
        'to stage those binaries and fail after the tag exists. Promote through the normal stable path ' +
        'instead, so the release contains the native-config change its binaries were built from.',
    );
  }
  return pass(`native-config prebuild ${head} is contained in the synthetic commit.`);
}

/**
 * Would this main-reset dispatch consolidate more than the point release
 * shipped?
 *
 * main-reset branches on `delta_ids != "null" && length > 0`, so an empty array
 * and an absent value both fall through to its consolidate-the-whole-pending-pile
 * branch. Dispatching either would consume every unsoaked changeset in one
 * sweep, which is precisely the outcome this lane exists to avoid, and it would
 * happen silently because from main-reset's side the dispatch looks like an
 * ordinary manual run.
 *
 * A caller with no delta to forward must SKIP the dispatch rather than send an
 * empty one.
 */
export function guardMainResetDeltaIds({ deltaIds }) {
  if (!Array.isArray(deltaIds) || deltaIds.length === 0) {
    return refuse(
      'empty-delta-ids',
      'Refusing to dispatch main-reset without an explicit changeset delta: it treats an empty or absent ' +
        'delta as consolidate-the-whole-pending-pile, which would consume every unsoaked changeset. ' +
        'Supply the delta, or skip the dispatch entirely.',
    );
  }
  return pass(`main-reset would consolidate exactly ${deltaIds.length} changeset(s).`);
}

// The cross-repo target for the changeset consolidation. The public release
// repo is a mirror; the changesets it consumes live in the monorepo, so the
// reset has to land there.
const MAIN_RESET_REPO = 'inkeep/agents-private';

/**
 * A precondition said no. Distinct from an ordinary Error so the CLI can exit
 * with its own status: a refusal means the repo is fine and the operator has
 * something to do, while a plain Error means the run could not decide at all.
 */
export class PointReleaseRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PointReleaseRefusal';
    this.code = code;
  }
}

function checkGuard(trail, verdict) {
  trail.push(verdict);
  if (!verdict.ok) throw new PointReleaseRefusal(verdict.code, verdict.message);
  return verdict;
}

/**
 * Run the point-release lane: build `lastStable + one fix` and ship it as the
 * new `latest`, skipping the soak the pending pile is still serving.
 *
 * `io` is the entire outside world, injected. Splitting it this way is not
 * decoration: the lane's central promise is that a dry run computes the whole
 * plan and changes nothing anyone can see, and the only way to prove that
 * without a live repo, live tags, and a live GitHub is for every remote-visible
 * effect to be a member of an object a test can hand in and then count.
 *
 *   io.readAnchorVersion()  -> 'X.Y.Z'   changeset anchor in the checked-out tree
 *   io.git.newestStableTag / revParse / isOnMain / tagExists / isAncestor /
 *          changesetIds / bumpTypeOf                            (read-only)
 *   io.git.checkoutDetached / cherryPick / revert / headSha      (local only)
 *   io.git.tag / pushTag                                         (REMOTE)
 *   io.gh.newestNativeConfigPrebuildHeadSha                      (read-only)
 *   io.gh.createRelease / dispatch                               (REMOTE)
 *
 * The four REMOTE members are the ones a dry run must never reach. Building the
 * synthetic commit is deliberately NOT one of them: a dry run that skipped the
 * cherry-pick would not find out whether the fix applies, which is most of what
 * the operator wants to learn before arming a real run. It happens on a
 * detached head in the runner's throwaway clone, so nothing survives the job.
 *
 * A dry run creates no tag at all, not even locally. "Leaves the repo
 * unchanged" is worth reading strictly, and a leftover local tag would make a
 * real re-run in the same checkout look like it had already shipped.
 *
 * Returns the plan (see the `plan` object below) or throws: PointReleaseRefusal
 * when a precondition says no, a plain Error when the boundary itself failed.
 */
export function runPointRelease(opts, io) {
  const { mode, fixRefs, anchorDeltaIds, dryRun = true, dispatchedBy = '', selfRepo = '', bridgeConfigured = true } =
    opts;

  if (mode !== 'cherry-pick' && mode !== 'revert') {
    throw new Error(`Point-release mode '${mode}' is not one of: cherry-pick, revert.`);
  }
  if (!Array.isArray(fixRefs) || fixRefs.length === 0) {
    throw new Error('Point-release requires at least one fix ref.');
  }

  const guards = [];
  const warnings = [];

  const latestStableTag = io.git.newestStableTag();
  if (!latestStableTag) {
    throw new Error('No stable tag exists in this clone; a point release is a patch over an existing stable.');
  }
  const latestStableSha = io.git.revParse(latestStableTag);

  checkGuard(guards, guardAnchor({ anchorVersion: io.readAnchorVersion(), latestStableTag }));
  checkGuard(guards, guardRefsOnMain({ fixRefs, isOnMain: io.git.isOnMain }));

  const resolvedRefs = fixRefs.map((ref) => ({ ref, sha: io.git.revParse(ref), onMain: true }));

  // Build the synthetic commit. Detaching first is what keeps the pile out of
  // the release: the tree starts as the last stable, so the only thing the
  // release can contain beyond it is what the picks add.
  io.git.checkoutDetached(latestStableSha);
  for (const { ref } of resolvedRefs) {
    applyFix(mode, ref, io);
  }
  const syntheticSha = io.git.headSha();

  const version = computePointReleaseVersion({ syntheticSha, latestStableTag, latestStableSha, mode }, io.git);

  checkGuard(guards, guardTagFree({ tag: version.tag, tagExists: io.git.tagExists }));
  checkGuard(
    guards,
    guardDeltaMatchesFix({
      mode,
      addedIds: version.addedIds,
      fixChangesetIds: mode === 'cherry-pick' ? changesetsIntroducedBy(resolvedRefs, io) : [],
    }),
  );
  checkGuard(guards, guardPatchOnly({ bump: version.bump }));
  checkGuard(
    guards,
    guardNativeConfigProvenance({
      prebuildHeadSha: io.gh.newestNativeConfigPrebuildHeadSha(),
      syntheticSha,
      isAncestor: io.git.isAncestor,
    }),
  );

  const mainReset = decideMainReset({ anchorDeltaIds, addedIds: version.addedIds, bridgeConfigured, guards, warnings });

  const plan = {
    mode,
    dryRun,
    latestStableTag,
    latestStableVersion: version.latestStableVersion,
    latestStableSha,
    fixRefs: resolvedRefs,
    syntheticSha,
    syntheticTree: {
      sha: syntheticSha,
      changesetCount: io.git.changesetIds(syntheticSha).length,
      addedIds: version.addedIds,
      removedIds: version.removedIds,
    },
    version: version.version,
    tag: version.tag,
    bump: version.bump,
    addedIds: version.addedIds,
    removedIds: version.removedIds,
    mainReset,
    guards,
    warnings,
  };

  if (dryRun) return plan;

  io.git.tag(plan.tag, syntheticSha);
  io.git.pushTag(plan.tag);

  // Past this point the tag is public and every remaining step is a remote,
  // non-idempotent call. A failure here leaves a half-shipped state, and unlike
  // `promote-stable.yml` this lane cannot make it resumable by checking whether
  // the tag already sits at the expected sha: that workflow tags an EXISTING
  // beta commit, which is byte-identical across retries, whereas this one
  // synthesizes a commit whose sha changes every run because cherry-pick and
  // revert both stamp a fresh committer date. A re-run therefore always collides
  // at a different sha, and skipping on that would tag the previous run's
  // commit. So the recovery is deliberately manual, and the job of this marker
  // is to make sure the operator is TOLD what exists rather than left to infer
  // it from a bare API error.
  try {
    // Draft, exactly as the ordinary promotion does. desktop-release.yml flips it
    // to published after the DMG and its update manifest are attached; publishing
    // here would put a release in the auto-updater's feed with no build behind it.
    io.gh.createRelease({
      tag: plan.tag,
      targetSha: syntheticSha,
      title: plan.tag,
      draft: true,
      notes: formatReleaseNotes(plan),
    });

    // The ONLY cascade dispatch for the release itself, matching what
    // promote-stable.yml now does. desktop-release.yml builds the DMG, smokes
    // it, promotes the draft Release, and only then dispatches publish-stable
    // to release.yml for npm. Dispatching publish-stable from here as well
    // would move npm `latest` before the smoke had a chance to refuse, which is
    // the failure that gate exists to prevent, and would publish twice.
    io.gh.dispatch({
      repo: selfRepo,
      eventType: 'desktop-release',
      clientPayload: { release_tag: plan.tag, ref: plan.tag, dispatched_by: dispatchedBy },
    });
    if (mainReset.dispatch) {
      io.gh.dispatch({
        repo: MAIN_RESET_REPO,
        eventType: 'main-reset',
        clientPayload: { stable_version: plan.version, delta_ids: mainReset.deltaIds, dispatched_by: dispatchedBy },
      });
    }
  } catch (err) {
    // Normalize rather than annotate-if-Error: the half-shipped warning is the
    // most consequential thing this run can say, and gating it on the thrown
    // value's type would drop it for exactly the unexpected failure where the
    // operator most needs to be told the tag is already public.
    const marked = err instanceof Error ? err : new Error(String(err));
    marked.pushedTag = plan.tag;
    throw marked;
  }

  return plan;
}

/**
 * Apply one fix onto the detached last-stable head.
 *
 * git already fails on a conflict, so the catch adds only context; it re-throws
 * and never swallows. The context is worth the wrapper: git's own message says
 * which paths collided, which reads as a mechanical problem an operator might
 * try to hand-resolve, when the actual finding is that the fix depends on
 * something between last stable and now and therefore cannot ship alone.
 *
 * There is deliberately no strategy or conflict-resolution option to reach for.
 * Any resolution would produce a tree that is neither last stable nor the fix
 * as reviewed, shipped straight to the default install channel with no soak.
 */
function applyFix(mode, ref, io) {
  try {
    if (mode === 'revert') io.git.revert(ref);
    else io.git.cherryPick(ref);
  } catch (err) {
    throw new PointReleaseRefusal(
      'apply-conflict',
      `Applying ${ref} onto the last stable hit a conflict (${mode}): ${err.message}. The fix is not ` +
        'self-contained over the current stable, so it cannot ship as a point release. Promote through ' +
        'the normal stable path, or pick the smaller commit that is self-contained.',
    );
  }
}

// The changesets each fix ref introduced on its own, which is what the delta
// guard compares the synthetic commit against. Read per ref against its own
// parent rather than against last stable, so a ref that merely touches a
// changeset already present in stable does not read as introducing it.
function changesetsIntroducedBy(resolvedRefs, io) {
  const introduced = [];
  for (const { ref } of resolvedRefs) {
    const before = new Set(io.git.changesetIds(`${ref}^`));
    for (const id of io.git.changesetIds(ref)) {
      if (!before.has(id) && !introduced.includes(id)) introduced.push(id);
    }
  }
  return introduced;
}

/**
 * Decide whether to forward a changeset delta to the main-reset consolidation,
 * and with what.
 *
 * The delta is the operator's `anchor_delta_ids` when they named one, and the
 * synthetic commit's own added changesets otherwise. Naming one is how revert
 * mode participates at all: a revert adds no changeset, so there is nothing to
 * derive, and the operator has to say which changeset they landed on main to
 * represent it.
 *
 * With nothing to forward the dispatch is SKIPPED, never sent empty: main-reset
 * reads an empty delta as consolidate-the-whole-pending-pile, so an empty
 * dispatch would sweep up every unsoaked changeset, which is the outcome this
 * whole lane exists to avoid.
 *
 * Skipping leaves the anchor behind the new stable, and every version-computing
 * path refuses on that drift, so the warning names both follow-ups rather than
 * leaving the next operator to discover the block.
 */
function decideMainReset({ anchorDeltaIds, addedIds, bridgeConfigured, guards, warnings }) {
  const named = String(anchorDeltaIds ?? '').trim() !== '';
  const deltaIds = named ? parseDeltaIds(anchorDeltaIds) : addedIds;

  if (!named && deltaIds.length === 0) {
    warnings.push(
      'Skipping the main-reset dispatch: this release forwards no changeset delta, and dispatching an ' +
        'empty one would consolidate the entire pending pile. Two follow-ups are now yours: land the fix ' +
        '(for a revert, the revert itself) on main so the pile stops carrying it, and run main-reset with ' +
        'that changeset so the anchor advances past this stable. Until the anchor advances, every ' +
        'version-computing path refuses.',
    );
    return { dispatch: false, deltaIds: null, skipReason: 'no-delta-to-forward' };
  }

  // Reached only when the operator named a delta or one was derived, so a
  // refusal here means they named something that parsed to nothing.
  checkGuard(guards, guardMainResetDeltaIds({ deltaIds }));

  if (!bridgeConfigured) {
    warnings.push(
      'Skipping the main-reset dispatch: the cross-repo bridge App is not configured on this repo. Run ' +
        `main-reset manually with delta_ids ${JSON.stringify(deltaIds)} so the anchor advances past this stable.`,
    );
    return { dispatch: false, deltaIds, skipReason: 'bridge-not-configured' };
  }

  return { dispatch: true, deltaIds, skipReason: null };
}

function formatReleaseNotes(plan) {
  const lines = [
    `Point release over ${plan.latestStableTag}: the current stable plus ${plan.fixRefs.length} applied ` +
      `commit(s), isolated from the changes still soaking on main.`,
    '',
    `Mode: ${plan.mode}`,
    `Applied: ${plan.fixRefs.map((r) => `${r.ref} (${r.sha})`).join(', ')}`,
  ];
  if (plan.addedIds.length > 0) lines.push(`Changesets added: ${plan.addedIds.join(', ')}`);
  if (plan.removedIds.length > 0) lines.push(`Changesets removed: ${plan.removedIds.join(', ')}`);
  return `${lines.join('\n')}\n`;
}

// --- workflow-runtime wiring (real git + gh boundary) ---

// Built on compute-stable-version's `realGit` rather than beside it, so the
// read-only members every version-computing path already shares keep exactly
// one implementation.
function realIo() {
  return {
    readAnchorVersion,
    git: {
      ...realGit,
      // Containment in the public repo's main, which the run's own checkout
      // tracks. fetch-depth 0 is what makes this answerable at all.
      isOnMain: (ref) => realGit.isAncestor(ref, 'origin/main'),
      // Three-way, matching `isAncestor`: exit 0 is a hit, exit 1 a clean miss,
      // anything else an infra failure that must fail loud. A one-way
      // `status === 0` reads a spawn failure (`status` is null when git cannot be
      // invoked at all) as "the tag is free", and this is the guard standing
      // between a concurrent promotion and a colliding tag.
      tagExists: (tag) => {
        const res = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { encoding: 'utf8' });
        if (res.status === 0) return true;
        if (res.status === 1) return false;
        throw new Error(
          `git rev-parse --verify refs/tags/${tag} failed (exit ${res.status}): ${res.error?.message ?? String(res.stderr || '').trim()}`,
        );
      },
      checkoutDetached: (sha) => void runGit(['checkout', '--detach', sha]),
      cherryPick: (ref) => void runGit(['cherry-pick', ref]),
      // --no-edit only suppresses the message editor; the pick is otherwise
      // whatever git produces, and a conflict still fails.
      revert: (ref) => void runGit(['revert', '--no-edit', ref]),
      headSha: () => runGit(['rev-parse', 'HEAD']).trim(),
      tag: (tag, sha) => void runGit(['tag', tag, sha]),
      pushTag: (tag) => void runGit(['push', 'origin', tag]),
    },
    gh: {
      newestNativeConfigPrebuildHeadSha: () => {
        // Same filters the publish path uses to pick the run it stages
        // binaries from. `--event push` is load-bearing: the prebuild workflow
        // also runs on pull_request, including external PRs against the public
        // mirror, so without it the newest green run can be unmerged source.
        const res = spawnSync(
          'gh',
          [
            'run',
            'list',
            '--workflow=native-config-prebuild.yml',
            '--branch',
            'main',
            '--event',
            'push',
            '--status',
            'success',
            '--limit',
            '1',
            '--json',
            'headSha',
            '--jq',
            '.[0].headSha // empty',
          ],
          { encoding: 'utf8' },
        );
        // An unreadable answer is not an empty answer. Returning '' on an auth
        // or rate-limit failure would refuse the release naming native-config
        // drift, sending the operator to investigate a repo state that is fine.
        if (res.status !== 0) {
          throw new Error(`gh run list for native-config-prebuild failed: ${String(res.stderr || '').trim()}`);
        }
        return String(res.stdout || '').trim();
      },
      createRelease: ({ tag, targetSha, title, draft, notes }) => {
        const args = ['release', 'create', tag, '--target', targetSha, '--title', title, '--notes', notes];
        if (draft) args.push('--draft');
        const res = spawnSync('gh', args, { encoding: 'utf8' });
        if (res.status !== 0) {
          throw new Error(`gh release create ${tag} failed: ${String(res.stderr || '').trim()}`);
        }
      },
      dispatch: ({ repo, eventType, clientPayload }) => {
        const res = spawnSync('gh', ['api', '-X', 'POST', `repos/${repo}/dispatches`, '--input', '-'], {
          encoding: 'utf8',
          input: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
          // The cross-repo consolidation runs on a different repo than the
          // release, so it needs the bridge App's token rather than this run's.
          env:
            repo === MAIN_RESET_REPO && process.env.BRIDGE_GH_TOKEN
              ? { ...process.env, GH_TOKEN: process.env.BRIDGE_GH_TOKEN }
              : process.env,
        });
        if (res.status !== 0) {
          throw new Error(`gh dispatch ${eventType} to ${repo} failed: ${String(res.stderr || '').trim()}`);
        }
      },
    },
  };
}

function log(...args) {
  process.stderr.write(`${args.join(' ')}\n`);
}

function main() {
  // Only a literal 'false' arms a real run. Anything else, including an unset
  // variable or a typo, stays a dry run: the failure mode of an accidental dry
  // run is a wasted minute, and of an accidental real one an unsoaked release
  // on the default install channel.
  const dryRun = process.env.DRY_RUN !== 'false';

  let plan;
  try {
    plan = runPointRelease(
      {
        mode: process.env.MODE,
        fixRefs: parseFixRefs(process.env.FIX_REFS),
        anchorDeltaIds: process.env.ANCHOR_DELTA_IDS,
        dryRun,
        dispatchedBy: process.env.DISPATCHED_BY || '',
        selfRepo: process.env.GITHUB_REPOSITORY || '',
        bridgeConfigured: process.env.BRIDGE_CONFIGURED === 'true',
      },
      realIo(),
    );
  } catch (err) {
    // `String(err)` for the non-Error case: reading `.message` off a thrown
    // non-Error annotates the run with the word "undefined" and nothing else.
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof PointReleaseRefusal) {
      console.error(`::error::point-release-plan (${err.code}): ${message}`);
      process.exit(2);
    }
    // The tag reached the remote and the cascade behind it did not finish. Say
    // so out loud: the operator's instinct is to re-run, and a re-run cannot
    // clear this on its own.
    if (err instanceof Error && err.pushedTag) {
      console.error(
        `::error::point-release-plan: ${message} | HALF-SHIPPED: tag ${err.pushedTag} IS already on ` +
          'the public repo but its cascade did not finish. Re-running will NOT resume it, because the ' +
          'next run synthesizes a new commit whose tag collides at a different sha. Either finish the ' +
          `cascade by hand, or delete the tag ("git push origin :refs/tags/${err.pushedTag}") and its ` +
          'draft Release, then re-run. See RELEASES.md, "Recovery: a point release failed partway".',
      );
      process.exit(1);
    }
    console.error(`::error::point-release-plan: ${message}`);
    process.exit(1);
  }

  for (const warning of plan.warnings) console.error(`::warning::${warning}`);
  for (const guard of plan.guards) log(`ok: ${guard.message}`);
  log(
    `${dryRun ? 'DRY RUN — nothing was pushed. Plan' : 'Shipped'}: ${plan.tag} (${plan.bump} over ` +
      `${plan.latestStableTag}) from ${plan.syntheticSha} = ${plan.latestStableTag} + ${plan.mode} of ` +
      `${plan.fixRefs.map((r) => r.ref).join(', ')}.`,
  );
  console.log(JSON.stringify(plan));

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `dry_run=${dryRun ? 'true' : 'false'}`,
        `point_release_tag=${plan.tag}`,
        `point_release_version=${plan.version}`,
        `latest_stable_tag=${plan.latestStableTag}`,
        `synthetic_sha=${plan.syntheticSha}`,
        `delta_ids=${JSON.stringify(plan.mainReset.deltaIds ?? [])}`,
        `main_reset_dispatched=${plan.mainReset.dispatch ? 'true' : 'false'}`,
        '',
      ].join('\n'),
    );
  }
}

// Run main() only as a CLI, not when the test file imports the predicates.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
