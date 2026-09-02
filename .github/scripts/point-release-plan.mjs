#!/usr/bin/env node
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

export function parseFixRefs(raw) {
  const refs = splitList(raw);
  if (refs.length === 0) {
    throw new Error(`no fix ref found in '${raw ?? ''}' (expected one or more commit SHAs, comma or space separated)`);
  }
  return refs;
}

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

export function parseResolvePaths(raw) {
  return splitList(raw);
}

const RESOLVABLE_PATH_VERIFIERS = Object.freeze({
  'pnpm-workspace.yaml': verifyWorkspaceMatchesLockfile,
});

export const RESOLVABLE_PATHS = Object.freeze(Object.keys(RESOLVABLE_PATH_VERIFIERS));

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

export function readTopLevelBlockEntries(text, header) {
  const lines = String(text).split('\n');
  const headerIndex = lines.findIndex((line) => line === `${header}:`);
  if (headerIndex < 0) return null;
  return readBlock(lines, headerIndex).entries;
}

function refuseResolution(message) {
  throw new PointReleaseRefusal('resolve-not-derivable', message);
}

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

  for (const line of removed) {
    if (count(resolved, line) !== 1) {
      refuseResolution(
        `The fix removes a line that does not appear exactly once in the last stable: ${line.trim()}. ` +
          'The stable has already diverged on that entry.',
      );
    }
    resolved.splice(resolved.indexOf(line), 1);
  }

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

  for (const [header, entries] of pending) {
    const block = readBlock(resolved, resolved.indexOf(header));
    resolved.splice(block.end, 0, ...entries);
  }

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

const LOCKFILE_MIRRORED_BLOCKS = Object.freeze([
  { block: 'patchedDependencies', compareValues: false },
  { block: 'overrides', compareValues: true },
]);

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

const MAIN_RESET_REPO = 'inkeep/agents-private';

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

  const resolutions = [];
  io.git.checkoutDetached(latestStableSha);
  for (const { ref } of resolvedRefs) {
    applyFix(mode, ref, io, resolvePaths, resolutions);
  }
  const syntheticSha = io.git.headSha();

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

  try {
    io.gh.createRelease({
      tag: plan.tag,
      targetSha: syntheticSha,
      title: plan.tag,
      draft: true,
      notes: plan.releaseNotes,
    });

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
    const marked = err instanceof Error ? err : new Error(String(err));
    marked.pushedTag = plan.tag;
    throw marked;
  }

  return plan;
}

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

  if (conflicted.length === 0) throw conflict;

  const unauthorized = conflicted.filter((path) => !authorized.includes(path));
  if (unauthorized.length > 0) {
    const eligible = unauthorized.filter((path) => RESOLVABLE_PATHS.includes(path));
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

function resolveConflictedPath({ mode, ref, path }, io) {
  const read = (rev) => {
    try {
      return io.git.fileAt(rev, path);
    } catch (err) {
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
    `Applied: ${plan.fixRefs.map((r) => (r.ref === r.sha ? r.sha : `${r.ref} (${r.sha})`)).join(', ')}`,
  ];
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

function realIo() {
  return {
    readAnchorVersion,
    fs: {
      readWorktreeFile: (path) => readFileSync(path, 'utf8'),
      writeWorktreeFile: (path, content) => writeFileSync(path, content),
    },
    git: {
      ...realGit,
      isOnMain: (ref) => realGit.isAncestor(ref, 'origin/main'),
      tagExists: (tag) => {
        const res = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { encoding: 'utf8' });
        if (res.status === 0) return true;
        if (res.status === 1) return false;
        throw new Error(
          `git rev-parse --verify refs/tags/${tag} failed (exit ${res.status}): ${res.error?.message ?? String(res.stderr || '').trim()}`,
        );
      },
      changesetContent: (sha, id) => runGit(['show', `${sha}:.changeset/${id}.md`]),
      checkoutDetached: (sha) => void runGit(['checkout', '--detach', sha]),
      cherryPick: (ref) => void runGit(['cherry-pick', ref]),
      revert: (ref) => void runGit(['revert', '--no-edit', ref]),
      conflictedPaths: () =>
        runGit(['diff', '--name-only', '--diff-filter=U'])
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== ''),
      fileAt: (rev, path) => runGit(['show', `${rev}:${path}`]),
      stage: (path) => void runGit(['add', '--', path]),
      continueApply: (mode) =>
        void runGit(['-c', 'core.editor=true', mode === 'revert' ? 'revert' : 'cherry-pick', '--continue']),
      headSha: () => runGit(['rev-parse', 'HEAD']).trim(),
      tag: (tag, sha) => void runGit(['tag', tag, sha]),
      pushTag: (tag) => void runGit(['push', 'origin', tag]),
    },
    gh: {
      selectNativeConfigPrebuild: (syntheticSha) => {
        const candidates = listPrebuildRuns();
        const treeAt = makeTreeAt();
        if (treeAt(syntheticSha) === null) {
          throw new Error(
            `could not read packages/native-config at the synthetic commit (${syntheticSha}); ` +
              'the working tree did not read, which is an infrastructure failure, not native-config drift',
          );
        }
        const selection = selectPrebuildRun({
          candidates,
          isAncestor: makeIsAncestor(),
          treeAt,
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
          throw new Error(
            `gh release create ${tag} failed: ${res.error?.message ?? String(res.stderr || '').trim()}`,
          );
        }
      },
      dispatch: ({ repo, eventType, clientPayload }) => {
        const res = spawnSync('gh', ['api', '-X', 'POST', `repos/${repo}/dispatches`, '--input', '-'], {
          encoding: 'utf8',
          input: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
          env:
            repo === MAIN_RESET_REPO && process.env.BRIDGE_GH_TOKEN
              ? { ...process.env, GH_TOKEN: process.env.BRIDGE_GH_TOKEN }
              : process.env,
        });
        if (res.status !== 0) {
          throw new Error(
            `gh dispatch ${eventType} to ${repo} failed: ${res.error?.message ?? String(res.stderr || '').trim()}`,
          );
        }
      },
    },
  };
}

function log(...args) {
  process.stderr.write(`${args.join(' ')}\n`);
}

function main() {
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
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof PointReleaseRefusal) {
      console.error(`::error::point-release-plan (${err.code}): ${message}`);
      process.exit(2);
    }
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
