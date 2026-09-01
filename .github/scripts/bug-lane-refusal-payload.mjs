#!/usr/bin/env node
/**
 * The Slack page for a bug-lane refusal.
 *
 * WHY this is not a format string in the workflow. A refusal that names a SHA
 * and a verdict tells a reader nothing they can act on, and `apply-conflict` in
 * particular reads as "this fix is incompatible with the stable" when the far
 * likelier cause is that an unrelated commit rewrote the same line of CI
 * config since the stable was cut. That is the same distinction the point
 * release runbook already draws for `pnpm-workspace.yaml` — config drift is
 * not a dependency — and it was never surfaced for this lane, so every
 * refusal read as the severe case. The reader has one question, "does this
 * need a manual point release?", and answering it requires knowing WHICH
 * paths collided and whether any of them carries behavior.
 *
 * This explains; it does not resolve. The lane keeps the unconditional hard
 * fail — automated dispatches never set `resolve_paths`, and nothing here
 * changes that. The classification decides what the message SAYS, never what
 * the lane DOES.
 *
 * Classification is fail-closed. A path is inert only when it is positively
 * proven to be both non-shipping and non-gating; anything unreadable,
 * unparseable, or merely unrecognized is reported as behavior-carrying. A
 * false "inert" would invite an operator to force through a fix that really
 * does depend on something the stable lacks, so the failure direction is
 * chosen deliberately: over-reporting severity costs a human a minute of
 * reading, under-reporting it costs a bad release.
 *
 * The page itself stays informational rather than alarming: no emoji, no
 * shouty header block, and no per-file listing (CARRIES BEHAVIOR / INERT) in
 * the channel. That per-path detail is genuinely not surfaced anywhere once
 * this returns — `classifyRefs`'s `detail` strings are computed and then
 * discarded, since nothing here writes to `console`, `::notice::`, or
 * `$GITHUB_STEP_SUMMARY`. What IS still visible without opening this file's
 * own output: the raw conflicting paths, which the pick loop already prints
 * to the run log independently (the "Verify the synthetic tree" step's
 * `--diff-filter=U` output), and the aggregate answer — config drift vs.
 * behavior-carrying — via the reason phrase below. Slack section blocks have
 * no expand/collapse control, so there is no way to fold the per-path detail
 * into the message itself without either always showing it or never showing
 * it; this file chooses never, on the belief that the aggregate answer is
 * what the channel needs to decide "does this need a human," and an operator
 * who needs the paths themselves is already going to open the run.
 *
 * Usage:
 *   node bug-lane-refusal-payload.mjs --input <json>
 *
 * Emits the payload as JSON on stdout. Everything is assembled through
 * JSON.stringify, so a commit subject containing quotes cannot corrupt the
 * body.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { gitCleanEnv } from '../../scripts/git-clean-env.mjs';

/**
 * Leaf keys whose divergence cannot change what a release does.
 *
 * `scripts.test:e2e` is the Playwright CI subset: a single ~10 KB line listing
 * every spec file the tier runs. Every commit that adds an e2e test appends to
 * it, which is exactly what a well-formed bug fix does, so it is the highest
 * churn line in the repo and collides with any sibling append that landed
 * since the stable. It is `test:e2e` specifically and not `test:*`: turbo runs
 * `test` as the lane's own verification tier, so a drifted `scripts.test`
 * WOULD change the verdict, while `test:e2e` is a separate task that the lane
 * never invokes.
 *
 * Entries are added only with both halves proven: the file does not reach a
 * user (enforced separately, below, by requiring the package be private) and
 * the key does not gate the verification the lane runs.
 */
export const INERT_JSON_KEYS = Object.freeze(new Set(['scripts.test:e2e']));

/** Dotted leaf paths, so `scripts.test:e2e` is one key rather than a subtree. */
function flattenJson(value, prefix = '', out = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    out[prefix] = JSON.stringify(value);
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    flattenJson(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

/** Leaf keys that differ between two parsed JSON documents, in sorted order. */
export function changedJsonKeys(before, after) {
  const a = flattenJson(before);
  const b = flattenJson(after);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]).sort();
}

/**
 * Is this conflicted path provably inert, and why?
 *
 * The question asked is deliberately about the FIX's own edit, not about the
 * conflict hunk: a textual conflict says two sides touched one line, while
 * what an operator needs to know is whether the change the fix is trying to
 * make carries behavior. So this reads what the fix changed relative to its
 * own parent and judges that.
 */
export function classifyConflictPath({ path, before, after }) {
  const unknown = (why) => ({ path, inert: false, detail: why });

  if (!path.endsWith('package.json')) {
    return unknown('carries behavior (or cannot be proven not to)');
  }
  let parsedBefore;
  let parsedAfter;
  try {
    parsedBefore = JSON.parse(before);
    parsedAfter = JSON.parse(after);
  } catch {
    return unknown('unreadable at one of the two revisions');
  }
  // The non-shipping half. A published package's manifest reaches users
  // whatever key moved, so it is never eligible regardless of the key.
  if (parsedAfter.private !== true) {
    return unknown('a published package manifest');
  }
  const keys = changedJsonKeys(parsedBefore, parsedAfter);
  // No line-level change means the conflict did not come from the fix, so
  // there is nothing here to judge as harmless.
  if (keys.length === 0) {
    return unknown('conflicted without the fix changing it');
  }
  const offenders = keys.filter((k) => !INERT_JSON_KEYS.has(k));
  if (offenders.length > 0) {
    return unknown(`changes ${offenders.join(', ')}`);
  }
  return {
    path,
    inert: true,
    detail: `${keys.join(', ')} only — private package, not in turbo \`test\`. Does not ship, does not gate.`,
  };
}

/** The real git boundary; injected as a fake in tests. */
export function makeGitShow(cwd = process.cwd()) {
  return (rev, path) => {
    try {
      return execFileSync('git', ['show', `${rev}:${path}`], {
        cwd,
        encoding: 'utf8',
        env: gitCleanEnv(),
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      return null;
    }
  };
}

/**
 * Classify every conflicted path of every dropped ref.
 *
 * A ref is only as resolvable as its worst path, so `inert` on the ref is the
 * conjunction: one behavior-carrying collision means the whole pick is the
 * severe case no matter how many harmless ones sit beside it.
 */
export function classifyRefs(refs, gitShow) {
  return refs.map((entry) => {
    const files = (entry.conflicts ?? []).map((path) => {
      const before = gitShow(`${entry.ref}^`, path);
      const after = gitShow(entry.ref, path);
      if (before === null || after === null) {
        return { path, inert: false, detail: 'unreadable at one of the two revisions' };
      }
      return classifyConflictPath({ path, before, after });
    });
    return {
      ...entry,
      files,
      inert: files.length > 0 && files.every((f) => f.inert),
    };
  });
}

/**
 * The classifier ran on this ref and found NO conflicting path.
 *
 * Deliberately `Array.isArray` and not `!r.files?.length`: the question is
 * whether classification happened and came back empty, which is a real and
 * reportable state, versus a caller that simply did not supply the field.
 */
const classifiedWithNoPaths = (r) => Array.isArray(r.files) && r.files.length === 0;

/**
 * The one thing worth telling a reader who is only scanning the channel: why
 * this did not ship, in three words or fewer, phrased as a noun so it reads
 * after "due to". Everything else — which files, which tests — lives in the
 * run, one click away, not in the page.
 */
export function reasonPhrase({ verdict, refs }) {
  if (verdict === 'could-not-verify') return 'verification timeout';
  // Deliberately does not say WHOSE verification is red. The tiers run on
  // the SYNTHETIC tree (stable + picked fixes), so a red run means either the
  // fix depends on something the stable lacks, or the stable is red on its
  // own — asserting either one here would be the exact over-claim the
  // two-cause hedge in `actionLine`'s `fail` branch exists to avoid.
  if (verdict === 'fail') return 'red verification';
  if (refs.length > 0 && refs.every((r) => r.inert)) return 'config drift';
  // No recorded conflicting path anywhere. Calling this a "conflict" would
  // assert a collision the classifier has no evidence for — the same
  // over-claim that once reported an empty pick (the stable already had the
  // fix) as a fix depending on later work.
  if (refs.length > 0 && refs.every(classifiedWithNoPaths)) return 'unclear pick failure';
  return 'behavior-carrying conflict';
}

/**
 * Scoped to the FIX, never the lane. On every verdict but `fail` that
 * distinction is academic — but a `fail` can mean the stable itself is red,
 * in which case the lane refuses every fix until that is repaired (see
 * `actionLine`'s `fail` branch), so an unscoped "no action needed" here would
 * assert the lane is fine on the one verdict where it might not be.
 */
function noActionSentence(verdict) {
  if (verdict === 'could-not-verify') {
    return 'No action needed — the lane retries this batch automatically on its next tick.';
  }
  if (verdict === 'fail') {
    return 'The fix itself needs nothing — it ships in the normal 24h soak lane in a future version.';
  }
  // Not "in a future version": on an evidence-free pick (`unclear pick
  // failure`) the likelier reading is the fix already shipped, so nothing
  // new is coming — `rides its cycle's stable` holds under either reading.
  return "No action needed — it rides its cycle's stable.";
}

function refLabel(entry) {
  const tickets = (entry.tickets ?? []).join(', ');
  return [`\`${entry.ref.slice(0, 9)}\``, tickets && `(${tickets})`].filter(Boolean).join(' ');
}

/** Who the headline is about. Only `conflict` has a specific ref to name. */
function headlineSubject({ verdict, refs }) {
  if (verdict !== 'conflict' || refs.length === 0) return 'The queued fix(es)';
  const [first, ...rest] = refs;
  const label = refLabel(first);
  return rest.length > 0 ? `${label} and ${rest.length} more` : label;
}

/**
 * The whole first line a reader needs: what failed to ship, why (three words
 * or fewer), what the stable is now, and that nothing is owed in response.
 */
export function buildHeadline({ verdict, refs, stable }) {
  return [
    `Bug lane: ${headlineSubject({ verdict, refs })} did not ship in the fast lane due to ${reasonPhrase({ verdict, refs })}.`,
    `Latest stable remains \`${stable}\`.`,
    noActionSentence(verdict),
  ].join(' ');
}

const MAX_REFS_SHOWN = 5;

/**
 * One line per ref: the count of conflicting files and how many applied
 * cleanly, never the paths or the per-file INERT/CARRIES-BEHAVIOR verdict —
 * see the top-of-file docstring for where that detail actually goes.
 */
function refSummaryLine(entry) {
  const label = refLabel(entry);
  const total = Number(entry.totalFiles);
  if (entry.files.length === 0) {
    return (
      `${label} — the pick failed but git reported no conflicting file` +
      `${Number.isFinite(total) && total > 0 ? `; all ${total} file${total === 1 ? '' : 's'} applied cleanly` : ''}.`
    );
  }
  const clean = Number.isFinite(total) ? total - entry.files.length : Number.NaN;
  return (
    `${label} — conflicted in ${entry.files.length} file${entry.files.length === 1 ? '' : 's'}` +
    `${Number.isFinite(clean) && clean > 0 ? `; ${clean} applied cleanly` : ''}.`
  );
}

function refSummaryLines(refs) {
  const lines = refs.slice(0, MAX_REFS_SHOWN).map(refSummaryLine);
  if (refs.length > MAX_REFS_SHOWN) {
    lines.push(`…and ${refs.length - MAX_REFS_SHOWN} more ref(s); see the run.`);
  }
  return lines;
}

/**
 * "Why it refused", for a red tier. Names at most the first failure and a
 * count — the full list is what the run log is for.
 */
function failureSummaryLines(failures, verdict) {
  if (verdict === 'could-not-verify') {
    if (failures.length === 0) {
      return [
        'The tiers ran out of their time budget, so nothing was verified about the queued fixes — see the run for where the time went.',
      ];
    }
    // Which attempt ran out is deliberately not claimed: a first-attempt blow
    // is never retried, but the retry can blow its own budget too. Does not
    // restate "the tiers did not finish" — in production `failures[0]` always
    // opens with exactly that phrase already, followed by the budget and
    // exit code (the workflow overwrites it unconditionally for this
    // verdict).
    const rest = failures.length > 1 ? ` and ${failures.length - 1} more` : '';
    return [`\`${failures[0]}\`${rest} — nothing was verified about the queued fixes.`];
  }
  if (failures.length === 0) {
    // Hedged: `verdict=fail` has two sites in the workflow, and the
    // `pnpm install --frozen-lockfile` failure exits BEFORE either attempt
    // runs, so it never populates `failures`.
    return [
      'Both attempts went red, or the install itself failed before either ran — see the run log.',
    ];
  }
  const rest = failures.length > 1 ? ` and ${failures.length - 1} more` : '';
  // The two-cause hedge lives in `actionLine`'s `fail` branch, which renders
  // on every `fail` including the zero-failures case this array never
  // reaches, rather than here.
  return [`\`${failures[0]}\`${rest} — not flake-class, failing on the second attempt too.`];
}

/**
 * What an operator can actually do, in one line. Branches verdict-first,
 * mirroring `reasonPhrase` — a `fail` or `could-not-verify` batch's `refs`
 * holds only refs DROPPED before the tiers ran, which is unrelated evidence
 * to the reason the batch itself refused, so those two verdicts must resolve
 * before any refs-based branching runs.
 *
 * Deliberately does not offer `resolve_paths` for the inert case: its
 * allowlist is code and covers only `pnpm-workspace.yaml` (the only path
 * `classifyConflictPath` ever marks inert is a `package.json`, which the
 * allowlist does not cover), so naming a package manifest refuses with
 * `resolve-path-not-allowlisted` before the tree is touched. Sending someone
 * to a door that is locked is worse than saying it is locked — this line
 * keeps that disqualifier inline rather than only implying it.
 */
export function actionLine({ verdict, refs }) {
  // "Identical refusals stay silent" is not repeated here — the unconditional
  // footer below already states it once, for every verdict.
  if (verdict === 'could-not-verify') {
    return "If this keeps happening, check the lane's recent runs.";
  }
  // A red tier's `refs` (if any) are dropped-before-the-tiers-ran evidence,
  // not the reason THIS batch refused — advising on them here would be the
  // exact cause-conflation the headline's cause-neutral reason phrase exists
  // to avoid. Phrased conditionally ("if a failure is named above") because
  // `failureSummaryLines` renders no named failure when the install itself
  // fails before either attempt runs, so this line still has to hold on that
  // path. Says "a failure", not "a failing test", because the verify step
  // falls back to turbo's failed-task lines when what went red is a
  // typecheck, which prints no per-test name at all.
  if (verdict === 'fail') {
    return 'If a failure is named above, check it against the fixes — one in code no fix touches means the stable is red on its own, which no re-run or smaller commit will clear; one a fix does touch means that fix depends on later work.';
  }
  if (refs.length > 0 && refs.every((r) => r.inert)) {
    return 'The collision is config drift, not a dependency, so the fix is already self-contained. `resolve_paths` does not cover this path, so hand-cutting needs a human decision — see RELEASES.md, "When the conflict is config drift, not a dependency".';
  }
  // No recorded conflicting path anywhere — the likeliest cause is that the
  // stable already shipped the fix, not that the commit needs re-cutting.
  // Confidently recommending a smaller commit here would assert the fix is
  // NOT self-contained over the stable, the opposite of what `apply-conflict`
  // (RELEASES.md) means for this class.
  if (refs.length > 0 && refs.every(classifiedWithNoPaths)) {
    return 'Read the cherry-pick output in the run before concluding anything — the fix may already be in the stable.';
  }
  return 'If it must ship sooner, the answer is a smaller self-contained commit, not a forced pick — see RELEASES.md, "When a guard refuses".';
}

export function buildSlackPayload({ verdict, stable, refs, runUrl, failures = [] }) {
  const headline = buildHeadline({ verdict, refs, stable });
  const body = [
    headline,
    '',
    '*Why it refused*',
    ...(verdict === 'fail' || verdict === 'could-not-verify'
      ? failureSummaryLines(failures, verdict)
      : refSummaryLines(refs)),
    // A red tier does not imply an empty `refs`. The pick loop writes its
    // `conflicts` output for every DROPPED ref and then lets the survivors run
    // the tiers, so a partial drop followed by a red tier arrives here with
    // real drop evidence, under its own heading rather than as the reason the
    // tiers went red.
    ...((verdict === 'fail' || verdict === 'could-not-verify') && refs.length > 0
      ? ['', '*Also dropped from this batch, before the tiers ran*', ...refSummaryLines(refs)]
      : []),
    '',
    actionLine({ verdict, refs }),
    '',
    // Only the run link is conditional; the blank separator above is
    // deliberate and must survive.
    ...(runUrl ? [`<${runUrl}|Run log>`] : []),
    '_Further identical refusals stay silent; the lane pages again only if the refusal changes._',
  ].join('\n');

  return {
    // `text` is the notification / a11y fallback Slack recommends alongside blocks.
    text: headline,
    // A single section block, no `header` block: the header rendered its text
    // large and bold, which is exactly the alarm the plain, lower-case
    // headline above is meant to defuse.
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: body } }],
  };
}

export function parseArgs(argv) {
  const args = {};
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!key.startsWith('--')) continue;
    args[key.slice(2)] = rest[i + 1] ?? '';
    i += 1;
  }
  if (!args.input) throw new Error('--input is required');
  const parsed = JSON.parse(args.input);
  return {
    verdict: parsed.verdict || 'conflict',
    stable: parsed.stable || '(unknown stable)',
    refs: Array.isArray(parsed.refs) ? parsed.refs : [],
    // Non-strings are dropped rather than stringified: this text is rendered
    // into the page verbatim, and "[object Object]" as a failing test name is
    // worse than the empty-reason line it would replace.
    failures: Array.isArray(parsed.failures)
      ? parsed.failures.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
      : [],
    runUrl: parsed.runUrl || '',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const parsed = parseArgs(process.argv);
    const refs = classifyRefs(parsed.refs, makeGitShow());
    process.stdout.write(JSON.stringify(buildSlackPayload({ ...parsed, refs })));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
