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
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  computePointReleaseVersion,
  evaluateAnchorGuard,
  readAnchorVersion,
  realGit,
  runGit,
} from '../../scripts/compute-stable-version.mjs';
import {
  describeNoSelection,
  listPrebuildRuns,
  makeIsAncestor,
  makeTreeAt,
  selectPrebuildRun,
} from './select-native-config-prebuild.mjs';
import { parseChangeset } from './write-back.mjs';

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
 * Split the operator's `resolve_paths` input into paths.
 *
 * Empty by default and empty for every automated dispatch, so the lane's
 * behavior on an unexpected conflict is unchanged: hard fail. Authorizing a
 * path is a deliberate, per-run operator act.
 */
export function parseResolvePaths(raw) {
  return splitList(raw);
}

/**
 * Config paths whose merge conflict MAY be resolved instead of refused, each
 * paired with the coherence check its resolution must survive.
 *
 * The allowlist is deliberately one entry. A fix delivered as a pnpm dependency
 * patch has to register itself in `pnpm-workspace.yaml`, and the registration
 * blocks there are dense: every entry sits within three lines of every other,
 * so any unrelated registration landing between the last stable and the fix
 * puts the fix's own line inside a rewritten hunk. That is an artifact of
 * diffing an unordered mapping by line, not evidence that the fix depends on
 * anything in between. `pnpm-lock.yaml` has the same churn but is not on this
 * list and does not need to be: it is enormous and sorted, so unrelated entries
 * are thousands of lines away and merge cleanly on their own. A conflict there
 * is a real signal and keeps refusing.
 *
 * Nothing that carries behavior is eligible. Source, workflows, and patch
 * contents are never resolvable, at any input.
 */
const RESOLVABLE_PATH_VERIFIERS = Object.freeze({
  'pnpm-workspace.yaml': verifyWorkspaceMatchesLockfile,
});

export const RESOLVABLE_PATHS = Object.freeze(Object.keys(RESOLVABLE_PATH_VERIFIERS));

/**
 * Does the operator's `resolve_paths` input name only allowlisted paths?
 *
 * Checked before the tree is touched, so a typo or an over-broad input refuses
 * in a second rather than after a pick. The allowlist is the security boundary
 * here: without it the input is a general "resolve my conflicts" switch aimed
 * at whatever the operator types, which is exactly the escape hatch this lane
 * must not grow.
 */
export function guardResolvePathsAllowlisted({ resolvePaths }) {
  const offenders = resolvePaths.filter((p) => !RESOLVABLE_PATHS.includes(p));
  if (offenders.length > 0) {
    return refuse(
      'resolve-path-not-allowlisted',
      `Not resolvable: ${offenders.join(', ')}. Only ${RESOLVABLE_PATHS.join(', ')} may be resolved, because ` +
        'only their conflicts can be re-derived as entry-level changes and checked afterwards. A conflict ' +
        'anywhere else means the fix depends on something between the last stable and now, and still refuses.',
    );
  }
  return pass(
    resolvePaths.length === 0
      ? 'No conflict resolution authorized; any conflict hard-fails.'
      : `Conflict resolution authorized for: ${resolvePaths.join(', ')}.`,
  );
}

const indentOf = (line) => line.length - line.trimStart().length;
const isBlank = (line) => line.trim() === '';

/**
 * The key an entry line declares, or null when the line is not a mapping entry.
 *
 * Quoted keys are read to their closing quote rather than to the first colon,
 * since the keys in these files are package specs that may contain one.
 */
function entryKey(line) {
  const body = line.trim();
  if (body === '' || body.startsWith('#') || body.startsWith('-')) return null;
  const quote = body[0];
  if (quote === "'" || quote === '"') {
    const close = body.indexOf(quote, 1);
    if (close < 0) return null;
    if (body[close + 1] !== ':') return null;
    return body.slice(1, close);
  }
  const colon = body.indexOf(':');
  if (colon <= 0) return null;
  return body.slice(0, colon);
}

/**
 * The mapping block a header line opens: where it ends, at what indentation its
 * entries sit, and the entries themselves — as `keys` for membership, and as an
 * `entries` key-to-value map for the comparisons that care what each assigns.
 *
 * A block runs from just after its header to the first non-blank line indented
 * no deeper than the header. `end` excludes the trailing blank lines so an
 * insertion lands against the last entry rather than after a paragraph break.
 *
 * This is a line scanner, not a YAML parser, and deliberately so: the workflow
 * runs `node` against a bare checkout with no dependency install, so there is
 * no parser to reach for. It therefore understands only the shape these two
 * files actually use — one key per line, a single-line value, one level of
 * nesting beneath an entry — and everything outside it reads as an entry with
 * no value, which fails the comparisons closed rather than passing something
 * unread. A new pnpm output shape is a refusal, not a silent misread.
 */
export function readBlock(lines, headerIndex) {
  const headerIndent = indentOf(lines[headerIndex]);
  let end = headerIndex + 1;
  while (end < lines.length && (isBlank(lines[end]) || indentOf(lines[end]) > headerIndent)) end++;
  while (end > headerIndex + 1 && isBlank(lines[end - 1])) end--;

  let entryIndent = null;
  for (let i = headerIndex + 1; i < end; i++) {
    if (isBlank(lines[i]) || entryKey(lines[i]) === null) continue;
    if (entryIndent === null || indentOf(lines[i]) < entryIndent) entryIndent = indentOf(lines[i]);
  }

  const entries = new Map();
  for (let i = headerIndex + 1; i < end; i++) {
    if (isBlank(lines[i]) || indentOf(lines[i]) !== entryIndent) continue;
    const key = entryKey(lines[i]);
    if (key !== null) entries.set(key, entryValue(lines[i]));
  }
  return { headerIndex, headerIndent, entryIndent, end, keys: new Set(entries.keys()), entries };
}

/**
 * What an entry line assigns, normalized.
 *
 * Quoting is not meaningful here and is not consistent across the two files
 * that get compared — the same override reads `"@types/node": ^24.7.0` in one
 * and `'@types/node': ^24.7.0` in the other — so surrounding quotes come off
 * both sides rather than reading as a difference. An entry that opens a nested
 * mapping assigns nothing and reads as empty.
 */
function entryValue(line) {
  const body = line.trim();
  const key = entryKey(line);
  if (key === null) return '';
  const after = body.slice(body.indexOf(':', body.indexOf(key) + key.length) + 1).trim();
  const quote = after[0];
  if ((quote === "'" || quote === '"') && after.endsWith(quote) && after.length > 1) {
    return after.slice(1, -1);
  }
  return after;
}

/** Every entry declared directly under a top-level mapping, or null when absent. */
export function readTopLevelBlockEntries(text, header) {
  const lines = String(text).split('\n');
  const headerIndex = lines.findIndex((line) => line === `${header}:`);
  if (headerIndex < 0) return null;
  return readBlock(lines, headerIndex).entries;
}

function refuseResolution(message) {
  throw new PointReleaseRefusal('resolve-not-derivable', message);
}

/**
 * Re-derive the fix's own change to a config file as an entry-level edit of the
 * last stable's copy of it, rather than as the textual hunk git could not place.
 *
 * The result is the stable file with exactly the entries the fix added added,
 * and exactly the entries it removed removed. That is the only resolution that
 * is correct, and the reason is concrete rather than aesthetic: taking the
 * fix's copy of the file wholesale adopts entries the synthetic tree cannot
 * honor (a patch registration whose `.patch` file is not in the tree, an
 * override the lockfile never resolved), and keeping the stable's copy
 * wholesale drops the fix's own entry while the lockfile keeps it. Both
 * produce a tree that cannot install; only the entry-level union matches the
 * lockfile git already merged cleanly beside it.
 *
 * Every step that cannot be re-derived unambiguously refuses. A modified entry,
 * an added line that is not a mapping entry, a block whose header is not in the
 * stable file, a line that does not appear exactly where it is expected to:
 * each of those is a real disagreement between the fix and the stable, and this
 * function is only allowed to handle the case where there is none.
 */
export function deriveEntryLevelResolution({ base, fixBefore, fixAfter }) {
  const baseLines = String(base).split('\n');
  const beforeLines = String(fixBefore).split('\n');
  const afterLines = String(fixAfter).split('\n');

  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  const added = afterLines.filter((line) => !isBlank(line) && !beforeSet.has(line));
  const removed = beforeLines.filter((line) => !isBlank(line) && !afterSet.has(line));

  if (added.length === 0 && removed.length === 0) {
    refuseResolution(
      'The fix makes no line-level change to this file, so the conflict does not come from the fix. ' +
        'Nothing can be re-derived.',
    );
  }

  const count = (lines, needle) => lines.reduce((n, line) => n + (line === needle ? 1 : 0), 0);
  const resolved = [...baseLines];

  // Removals first: they are matched against the stable file as it stands, and
  // doing them after an insertion would let a just-added line satisfy one.
  for (const line of removed) {
    if (count(resolved, line) !== 1) {
      refuseResolution(
        `The fix removes a line that does not appear exactly once in the last stable: ${line.trim()}. ` +
          'The stable has already diverged on that entry.',
      );
    }
    resolved.splice(resolved.indexOf(line), 1);
  }

  // Group the additions by the block they belong to, in the order the fix wrote
  // them. Only mapping entries qualify: a comment or a sequence item has no key
  // to place it by, so a fix that adds one refuses here rather than having this
  // code guess what it was attached to.
  const pending = new Map();
  for (const line of added) {
    const key = entryKey(line);
    if (key === null || indentOf(line) === 0) {
      refuseResolution(
        `The fix adds a line that is not an indented mapping entry: ${line.trim()}. Only entries inside an ` +
          'existing block can be re-derived; anything else changes the file structure.',
      );
    }
    if (count(afterLines, line) !== 1 || count(resolved, line) !== 0) {
      refuseResolution(
        `The fix's added line is ambiguous against the last stable: ${line.trim()}. It must be unique in the ` +
          'fix and absent from the stable.',
      );
    }

    const at = afterLines.indexOf(line);
    let headerIndex = -1;
    for (let i = at - 1; i >= 0; i--) {
      if (isBlank(afterLines[i]) || indentOf(afterLines[i]) >= indentOf(line)) continue;
      headerIndex = i;
      break;
    }
    if (headerIndex < 0) {
      refuseResolution(`The fix's added line sits in no enclosing block: ${line.trim()}.`);
    }
    const header = afterLines[headerIndex];
    if (count(resolved, header) !== 1) {
      refuseResolution(
        `The block this entry belongs to is not in the last stable, or is not unique there: ${header.trim()}. ` +
          'There is nowhere unambiguous to place the entry.',
      );
    }
    if (readBlock(resolved, resolved.indexOf(header)).keys.has(key)) {
      refuseResolution(
        `The last stable already declares '${key}' in ${header.trim()} with a different value, so the fix ` +
          'CHANGES that entry rather than adding one. Re-deriving would silently pick a side.',
      );
    }
    if (!pending.has(header)) pending.set(header, []);
    pending.get(header).push(line);
  }

  // Append rather than sort into place: appending is inside the right block by
  // construction, and where an entry sits in an unordered mapping carries no
  // meaning. Guessing a sorted position would, since the stable's block need
  // not be sorted at all.
  for (const [header, entries] of pending) {
    // Located afresh per block, so an insertion into an earlier one does not
    // leave a later block's index stale.
    const block = readBlock(resolved, resolved.indexOf(header));
    resolved.splice(block.end, 0, ...entries);
  }

  // The transform claimed above, asserted rather than trusted. Anything that
  // reordered, duplicated or dropped a line the fix did not name shows up here.
  const ok =
    resolved.length === baseLines.length + added.length - removed.length &&
    sameSet(diffLines(resolved, baseLines), added) &&
    sameSet(diffLines(baseLines, resolved), removed) &&
    isSubsequence(
      baseLines.filter((line) => !removed.includes(line)),
      resolved,
    );
  if (!ok) {
    throw new PointReleaseRefusal(
      'resolve-incoherent',
      'The re-derived file is not the last stable plus exactly the entries the fix added, minus exactly the ' +
        'entries it removed. Refusing rather than shipping a tree nobody wrote.',
    );
  }

  return { resolved: resolved.join('\n'), added, removed };
}

const diffLines = (from, to) => {
  const other = new Set(to);
  return from.filter((line) => !isBlank(line) && !other.has(line));
};
const sameSet = (a, b) => a.length === b.length && a.every((line) => b.includes(line));

function isSubsequence(needles, haystack) {
  let at = 0;
  for (const needle of needles) {
    at = haystack.indexOf(needle, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

/**
 * The workspace-file blocks the lockfile mirrors, and how far each is
 * comparable.
 *
 * pnpm hard-fails a frozen install when EITHER of these disagrees between the
 * two files, and the failure text names the block. Checking only one of them
 * would leave a re-derivation of the other verified by a comparison that
 * passes vacuously, since an untouched block trivially matches.
 */
const LOCKFILE_MIRRORED_BLOCKS = Object.freeze([
  // The workspace file assigns a patch PATH; the lockfile opens a nested
  // hash + path mapping. Only the key sets are comparable.
  { block: 'patchedDependencies', compareValues: false },
  // Both assign the same version spec, and a spec that disagrees fails a frozen
  // install exactly as hard as a missing key.
  { block: 'overrides', compareValues: true },
]);

/**
 * Does the re-derived workspace file still agree with the lockfile beside it?
 *
 * The lockfile is an independent arbiter: git merged it on its own, from the
 * same two sides, so it says what the resolution should have been without this
 * code having any say. Both of the resolutions this lane refuses to perform are
 * caught by exactly this comparison, and so is a derivation bug.
 *
 * Without it the failure surfaces as ERR_PNPM_LOCKFILE_CONFIG_MISMATCH in the
 * publish job, after the tag and the Release already exist.
 *
 * Fails closed. An unreadable lockfile is not agreement.
 */
export function verifyWorkspaceMatchesLockfile({ resolved, readWorktreeFile }) {
  const lockfile = readWorktreeFile('pnpm-lock.yaml');
  const notes = [];
  for (const { block, compareValues } of LOCKFILE_MIRRORED_BLOCKS) {
    const inWorkspace = readTopLevelBlockEntries(resolved, block) ?? new Map();
    const inLockfile = readTopLevelBlockEntries(lockfile, block) ?? new Map();
    const render = (entries) =>
      [...entries]
        .map(([key, value]) => (compareValues ? `${key}: ${value}` : key))
        .sort()
        .join('\n');
    const left = render(inWorkspace);
    const right = render(inLockfile);
    if (left !== right) {
      const only = (a, b) =>
        [...a]
          .filter(([key, value]) => !b.has(key) || (compareValues && b.get(key) !== value))
          .map(([key, value]) => (compareValues ? `${key}: ${value}` : key));
      throw new PointReleaseRefusal(
        'resolve-incoherent',
        `The re-derived pnpm-workspace.yaml disagrees with the merged pnpm-lock.yaml on '${block}'. Only in the ` +
          `workspace file: [${only(inWorkspace, inLockfile).join(', ') || 'none'}]. Only in the lockfile: ` +
          `[${only(inLockfile, inWorkspace).join(', ') || 'none'}]. A frozen install refuses on that mismatch, ` +
          'which would fail the publish after the tag already exists.',
      );
    }
    notes.push(`${block} (${inWorkspace.size})`);
  }
  return `agrees with the lockfile on ${notes.join(' and ')}.`;
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
 * The publish workflow stages prebuilt native binaries from the newest prebuild
 * run on `main` that is BOTH contained in the commit being released and built
 * from that commit's `packages/native-config` source, and on the stable path
 * only it HARD-FAILS when there is no such run. The synthetic commit is built on
 * the last stable, so a native-config change that landed on `main` since then
 * puts the newest prebuild out of reach — but an older prebuild built from the
 * source the synthetic commit actually carries is still a valid bundle, and the
 * publish will find it.
 *
 * The reason to check it here is ordering, not novelty: that failure happens
 * after the tag and the GitHub Release already exist, leaving a version users
 * can see with nothing published behind it, on the exact channel this lane is
 * supposed to be repairing. Checking the same condition before anything is
 * created turns it into a clean refusal.
 *
 * `selection` comes from the same selector the publish path runs, so the
 * prediction and the publish cannot drift apart: an empty `headSha` is exactly
 * the state that would refuse the cut, and its `reason` is the selector's own
 * account of why nothing qualified.
 */
export function guardNativeConfigProvenance({ selection }) {
  const head = String(selection?.headSha ?? '').trim();
  if (head === '') {
    const reason =
      String(selection?.reason ?? '').trim() ||
      'No qualifying native-config-prebuild run found on main';
    return refuse(
      'native-config-drift',
      `${reason}. The stable publish stages its native binaries from that run and refuses without ` +
        'them, so this release would fail after tagging. Promote through the normal stable path ' +
        'instead, so the release contains the native-config change its binaries were built from.',
    );
  }
  return pass(
    `native-config prebuild ${head} carries the synthetic commit's packages/native-config source.`,
  );
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
 *          changesetIds / bumpTypeOf / conflictedPaths / fileAt  (read-only)
 *   io.git.checkoutDetached / cherryPick / revert / stage /
 *          continueApply / headSha                               (local only)
 *   io.fs.readWorktreeFile / writeWorktreeFile                    (local only)
 *   io.git.tag / pushTag                                         (REMOTE)
 *   io.gh.selectNativeConfigPrebuild                             (read-only)
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
  const {
    mode,
    fixRefs,
    anchorDeltaIds,
    resolvePaths = [],
    dryRun = true,
    dispatchedBy = '',
    selfRepo = '',
    bridgeConfigured = true,
  } = opts;

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
  checkGuard(guards, guardResolvePathsAllowlisted({ resolvePaths }));

  const resolvedRefs = fixRefs.map((ref) => ({ ref, sha: io.git.revParse(ref), onMain: true }));

  // Build the synthetic commit. Detaching first is what keeps the pile out of
  // the release: the tree starts as the last stable, so the only thing the
  // release can contain beyond it is what the picks add.
  const resolutions = [];
  io.git.checkoutDetached(latestStableSha);
  for (const { ref } of resolvedRefs) {
    applyFix(mode, ref, io, resolvePaths, resolutions);
  }
  const syntheticSha = io.git.headSha();

  // Loud, and in the guard trail rather than only in the plan JSON: a release
  // built on a re-derived config file is not a plain pick, and the operator
  // reading the run log has to see which entries were transplanted before they
  // decide to arm it.
  for (const r of resolutions) {
    const entries = [...r.removed.map((line) => `-${line.trim()}`), ...r.added.map((line) => `+${line.trim()}`)];
    guards.push(
      pass(`Re-derived ${r.path} for ${r.ref} rather than refusing the conflict: ${entries.join(' ')} — ${r.verified}`),
    );
    warnings.push(
      `${r.ref} did not apply cleanly: ${r.path} conflicted and was re-derived as the last stable plus the ` +
        `entries the fix itself changed (${entries.join(' ')}). Read that diff before arming a real run.`,
    );
  }

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
      selection: io.gh.selectNativeConfigPrebuild(syntheticSha),
    }),
  );

  const mainReset = decideMainReset({ anchorDeltaIds, addedIds: version.addedIds, bridgeConfigured, guards, warnings });

  // The Release body is what every announcement channel renders verbatim
  // (Slack/Discord inline it), so it quotes each added changeset's prose the
  // way a stable's aggregated notes do, rather than listing ids. Reads are
  // best-effort per entry: notes are cosmetic and must never refuse a release,
  // so a failed read degrades that entry to its id. Composed at plan time so a
  // dry run previews the exact announcement.
  const changesetEntries = version.addedIds.map((id) => {
    let body = null;
    try {
      body = parseChangeset(io.git.changesetContent(syntheticSha, id))?.body ?? null;
    } catch {
      body = null;
    }
    return { id, body };
  });

  const plan = {
    mode,
    dryRun,
    latestStableTag,
    latestStableVersion: version.latestStableVersion,
    latestStableSha,
    fixRefs: resolvedRefs,
    resolvedPaths: resolutions,
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
    changesetEntries,
    mainReset,
    guards,
    warnings,
  };
  plan.releaseNotes = formatReleaseNotes(plan);

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
      notes: plan.releaseNotes,
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
 * A conflict is a hard fail, and stays one for anything the operator did not
 * explicitly authorize. git's own message names the paths that collided, which
 * reads as a mechanical problem someone might try to hand-resolve, when the
 * finding is usually that the fix depends on something between the last stable
 * and now and therefore cannot ship alone.
 *
 * The exception is narrow and has to be asked for by path. A fix delivered as a
 * dependency patch is disqualified by drift in a config registry rather than by
 * any dependency of its own, and the `authorized` set is how an operator says
 * so for one named file after a dry run showed them the conflict. Even then the
 * conflict is not resolved so much as sidestepped: the file is re-derived from
 * the stable plus the fix's own entries, and every step that cannot be derived
 * unambiguously refuses. There is still no strategy option to reach for, and no
 * way to authorize a path that carries behavior.
 */
function applyFix(mode, ref, io, authorized, resolutions) {
  let conflict;
  try {
    if (mode === 'revert') io.git.revert(ref);
    else io.git.cherryPick(ref);
    return;
  } catch (err) {
    conflict = err;
  }

  const conflicted = io.git.conflictedPaths();

  // The apply failed but git left nothing unmerged, so it did not fail on a
  // conflict: an empty pick, a dirty tree, a spawn failure. Calling any of
  // those "not self-contained" would send the operator to pick a different
  // commit over a problem that is not about the commit at all, so the original
  // error propagates with git's own text and the run exits as undecided rather
  // than as a refusal.
  if (conflicted.length === 0) throw conflict;

  const unauthorized = conflicted.filter((path) => !authorized.includes(path));
  if (unauthorized.length > 0) {
    // Named rather than left in git's own text, because which paths collided is
    // the whole finding: it is what tells the operator whether the fix depends
    // on something in between or merely landed beside a config registry that
    // drifted. Everything unauthorized is listed, not just the first.
    const eligible = unauthorized.filter((path) => RESOLVABLE_PATHS.includes(path));
    // Spelled as the flag the operator just typed, so it splices straight into
    // the `gh workflow run` line they are re-running under time pressure.
    const hint =
      eligible.length > 0
        ? ` ${eligible.join(', ')} is a config registry whose conflict can be re-derived from the entries the fix ` +
          `itself changes. Re-run with \`-f resolve_paths=${eligible.join(',')}\` to authorize that, and read the ` +
          'resolved entries the plan prints before arming a real run.'
        : '';
    throw new PointReleaseRefusal(
      'apply-conflict',
      `Applying ${ref} onto the last stable hit a conflict (${mode}): ${messageOf(conflict)}. Unresolved ` +
        `conflicts in: ${unauthorized.join(', ')}. The fix is not self-contained over the current stable, so it ` +
        'cannot ship as a point release. Promote through the normal stable path, or pick the smaller commit that ' +
        'is self-contained.' +
        hint,
    );
  }

  for (const path of conflicted) {
    resolutions.push(resolveConflictedPath({ mode, ref, path }, io));
    io.git.stage(path);
  }
  io.git.continueApply(mode);
}

const messageOf = (err) => (err instanceof Error ? err.message : String(err));

/**
 * Re-derive one authorized path and write it into the working tree.
 *
 * The base is HEAD rather than the stable tag, so a second ref in the same run
 * derives against what the first one produced instead of silently reverting it.
 * Revert mode reads the fix's two sides swapped, since a revert applies that
 * commit's change backwards.
 */
function resolveConflictedPath({ mode, ref, path }, io) {
  const read = (rev) => {
    try {
      return io.git.fileAt(rev, path);
    } catch (err) {
      // Only git's own "that tree has no such path" is a structural finding —
      // the fix creates or deletes the file, which is not an entry-level edit.
      // Anything else (a spawn failure, a broken object store) is the run being
      // unable to decide, and reclassifying it as a refusal would hand the
      // operator a factually wrong diagnosis plus the exit code that tells them
      // to change their approach rather than to re-run.
      if (!/does not exist in|exists on disk, but not in/.test(messageOf(err))) throw err;
      throw new PointReleaseRefusal(
        'resolve-not-derivable',
        `${path} does not exist at ${rev}, so the fix creates or deletes it rather than editing entries in it.`,
      );
    }
  };

  const { resolved, added, removed } = deriveEntryLevelResolution({
    base: read('HEAD'),
    fixBefore: read(mode === 'revert' ? ref : `${ref}^`),
    fixAfter: read(mode === 'revert' ? `${ref}^` : ref),
  });

  const verified = RESOLVABLE_PATH_VERIFIERS[path]({
    resolved,
    readWorktreeFile: io.fs.readWorktreeFile,
  });
  io.fs.writeWorktreeFile(path, resolved);
  return { ref, path, added, removed, verified };
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

export function formatReleaseNotes(plan) {
  const lines = [
    `Point release over ${plan.latestStableTag}: the current stable plus ${plan.fixRefs.length} applied ` +
      `commit(s), isolated from the changes still soaking on main.`,
    '',
    // No `Mode:` line. Whether the operator reached this stable by cherry-pick
    // or by revert is release mechanics; it reads as noise in the Slack and
    // Discord announcements, which inline this body verbatim. The workflow run
    // summary still records the mode for whoever is auditing the lane.
    // `ref (sha)` is only worth printing when the ref is a NAME — a tag or
    // branch the reader cannot resolve themselves. The bug lane dispatches
    // full SHAs, where `ref` and `sha` are the same 40 characters and the
    // parenthetical renders as the same hash twice.
    `Applied: ${plan.fixRefs.map((r) => (r.ref === r.sha ? r.sha : `${r.ref} (${r.sha})`)).join(', ')}`,
  ];
  // Quote each added changeset's prose under the same level heading a stable's
  // aggregated notes use, so the announcement channels render both release
  // kinds identically. The bump is guarded patch-only, so the heading is
  // always `Patch Changes`. Entries whose content could not be read fall back
  // to the old id list so the body never claims less than the ids conveyed.
  const entries = plan.changesetEntries ?? [];
  const quoted = entries.filter((e) => e.body);
  const unquoted = entries.filter((e) => !e.body);
  if (quoted.length > 0) {
    lines.push('', '### Patch Changes', '');
    for (const e of quoted) {
      lines.push(`- ${e.body.split('\n').join('\n  ')}`);
    }
  }
  const unquotedIds = entries.length > 0 ? unquoted.map((e) => e.id) : plan.addedIds;
  if (unquotedIds.length > 0) lines.push('', `Changesets added: ${unquotedIds.join(', ')}`);
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
    // Working-tree reads and writes, kept off the git boundary because they are
    // not git operations: the only writer is the config re-derivation, and the
    // only reader is the coherence check that follows it.
    fs: {
      readWorktreeFile: (path) => readFileSync(path, 'utf8'),
      writeWorktreeFile: (path, content) => writeFileSync(path, content),
    },
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
      // Raw changeset contents from the synthetic commit, for the release
      // notes. runGit fails loud on a bad read; the caller degrades per entry.
      changesetContent: (sha, id) => runGit(['show', `${sha}:.changeset/${id}.md`]),
      checkoutDetached: (sha) => void runGit(['checkout', '--detach', sha]),
      cherryPick: (ref) => void runGit(['cherry-pick', ref]),
      // --no-edit only suppresses the message editor; the pick is otherwise
      // whatever git produces, and a conflict still fails.
      revert: (ref) => void runGit(['revert', '--no-edit', ref]),
      // The unmerged entries git left in the index, which is the authoritative
      // list of what actually collided. Reading it from the exception text
      // instead would depend on git's advice formatting.
      conflictedPaths: () =>
        runGit(['diff', '--name-only', '--diff-filter=U'])
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== ''),
      fileAt: (rev, path) => runGit(['show', `${rev}:${path}`]),
      stage: (path) => void runGit(['add', '--', path]),
      // Finishes the in-progress apply with the message git already staged, so
      // the synthetic commit still carries the fix's own subject. core.editor
      // is neutralized for this one invocation because a runner has no editor.
      continueApply: (mode) =>
        void runGit(['-c', 'core.editor=true', mode === 'revert' ? 'revert' : 'cherry-pick', '--continue']),
      headSha: () => runGit(['rev-parse', 'HEAD']).trim(),
      tag: (tag, sha) => void runGit(['tag', tag, sha]),
      pushTag: (tag) => void runGit(['push', 'origin', tag]),
    },
    gh: {
      // The publish path's own selector, run against the synthetic commit.
      // Sharing it is the point: this preflight exists only to predict what the
      // publish will decide, so re-deriving the rule here is how the two drift
      // apart and the refusal starts describing a repo state that is fine.
      selectNativeConfigPrebuild: (syntheticSha) => {
        // listPrebuildRuns throws on a non-zero `gh`: an unreadable answer is
        // not an empty answer, and returning '' on an auth or rate-limit
        // failure would refuse the release naming native-config drift.
        const candidates = listPrebuildRuns();
        const selection = selectPrebuildRun({
          candidates,
          isAncestor: makeIsAncestor(),
          treeAt: makeTreeAt(),
          releaseRef: syntheticSha,
        });
        return selection
          ? { headSha: selection.headSha, reason: '' }
          : { headSha: '', reason: describeNoSelection(candidates) };
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
        resolvePaths: parseResolvePaths(process.env.RESOLVE_PATHS),
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
        `resolved_paths=${JSON.stringify(plan.resolvedPaths.map((r) => r.path))}`,
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
