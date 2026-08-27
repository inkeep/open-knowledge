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
 * Usage:
 *   node bug-lane-refusal-payload.mjs --input <json> [--repo owner/name]
 *
 * Emits the payload as JSON on stdout. Everything is assembled through
 * JSON.stringify, so a commit subject containing quotes cannot corrupt the
 * body.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { gitCleanEnv } from '../../scripts/git-clean-env.mjs';

const DEFAULT_REPO = 'inkeep/open-knowledge';

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
 * The headline has one job: let a reader scanning the channel tell a fix that
 * genuinely cannot ship from one that is only blocked by churn, without
 * opening the run.
 */
/**
 * The classifier ran on this ref and found NO conflicting path.
 *
 * Deliberately `Array.isArray` and not `!r.files?.length`: the question is
 * whether classification happened and came back empty, which is a real and
 * reportable state, versus a caller that simply did not supply the field.
 */
const classifiedWithNoPaths = (r) => Array.isArray(r.files) && r.files.length === 0;

export function describeRefusal({ verdict, refs }) {
  if (verdict === 'could-not-verify') {
    return {
      // Deliberately not "failed": the tiers ran out of budget, so there is no
      // result to report about the batch either way. Every clause of the `fail`
      // wording below would be false here, and the one an operator acts on
      // ("not a retry candidate") would be the exact inverse of the truth.
      headline: 'Bug lane: could not verify the synthetic tree',
      meaning:
        'The fast tiers ran out of their time budget rather than finishing. Nothing was verified, so this says nothing about the queued fixes.',
    };
  }
  if (verdict === 'fail') {
    return {
      headline: 'Bug lane: verification failed on the synthetic tree',
      // Says what is known and stops there. This used to assert "a real
      // conflict with the stable", which is one of two causes and not the one
      // that actually happened: the tiers can be red because the STABLE's own
      // tree is red, in which case every fix refuses and none of them is at
      // fault. Reading a base failure as an incompatible fix is how a lane-wide
      // outage looks like a run of bad luck with the fixes.
      meaning:
        'The fast tiers went red on BOTH attempts, or the install failed. Past flake-class, so either the fix depends on something the stable lacks or the stable is red on its own.',
    };
  }
  if (refs.length > 0 && refs.every((r) => r.inert)) {
    return {
      headline: 'Bug lane: point release blocked by config drift, not by the fix',
      meaning:
        'Every collision is in a path that neither ships nor gates verification. The fix itself applies cleanly to the stable.',
    };
  }
  // No recorded conflicting path anywhere. The severe headline below asserts
  // "at least one collision carries behavior", and with zero paths there is no
  // collision to say that about — saying it anyway is how a pick that applied
  // EMPTY (the stable already had the fix) got reported as a fix that depends
  // on later work. The verify stage now routes empty picks away from here
  // entirely, so reaching this branch means the pick failed some third way;
  // report the uncertainty instead of inventing a cause for it.
  if (refs.length > 0 && refs.every(classifiedWithNoPaths)) {
    return {
      headline: 'Bug lane: the pick failed without a conflicting path',
      meaning:
        'The cherry-pick exited non-zero but left no conflicting file, so its cause is not visible from here. Read the run log before concluding anything about the fix.',
    };
  }
  return {
    headline: 'Bug lane: the fix does not apply to the current stable',
    meaning:
      'At least one collision is in a path that carries behavior, so the fix depends on something that landed after the stable was cut.',
  };
}

/**
 * What an operator can actually do. Deliberately does not offer
 * `resolve_paths` for the inert case: its allowlist is code and covers only
 * `pnpm-workspace.yaml`, so naming a package manifest refuses with
 * `resolve-path-not-allowlisted` before the tree is touched. Sending someone
 * to a door that is locked is worse than saying it is locked.
 */
export function optionsFor({ verdict, refs }) {
  if (verdict === 'could-not-verify') {
    return [
      'Nothing here is evidence about the fixes — the tiers did not finish, so no test passed or failed on their account.',
      'The batch stays pending and the next tick retries it. Unlike a red verification, this IS a retry candidate.',
      'If this keeps happening the runner or the budget is the thing to look at — but identical refusals stay silent, so check the lane\u2019s recent runs rather than waiting to be paged again.',
    ];
  }
  if (verdict === 'fail') {
    return [
      'Check the failures above against the fixes first — a failure in code no fix touches means the STABLE is red, which no amount of re-running or re-picking will clear.',
      'If the failures do sit in code a fix touches, that fix depends on later work. Either way it is not a retry candidate.',
      'The fixes ride their cycle’s stable. Forcing them past a red verification is not an option this lane offers.',
    ];
  }
  if (refs.length > 0 && refs.every(classifiedWithNoPaths)) {
    return [
      'Open the run log and read the cherry-pick output — the failure left no conflicting path, so the log is the only place the cause exists.',
      'Do not hand-cut a point release off this page alone. Confirm what actually failed first; the fix may already be in the stable.',
    ];
  }
  const allInert = refs.length > 0 && refs.every((r) => r.inert);
  if (allInert) {
    return [
      'Do nothing — the fix ships with its cycle’s stable on the ordinary soak. Since the collision carries no behavior, waiting costs only time.',
      'If the fix is urgent enough to hand-cut: it IS self-contained over the stable, so the usual "pick a smaller commit" advice does not apply. `resolve_paths` does not cover this path (allowlist is code, `pnpm-workspace.yaml` only), so it needs a human decision — see RELEASES.md, "When the conflict is config drift, not a dependency".',
    ];
  }
  return [
    'Let it ride its cycle’s stable. A behavior-carrying collision means the fix genuinely depends on later work.',
    'If it must ship sooner, the answer is a smaller self-contained commit, not a forced pick — see RELEASES.md, "When a guard refuses".',
  ];
}

const MAX_REFS_SHOWN = 5;
const MAX_FILES_SHOWN = 8;

function refLines(refs) {
  const lines = [];
  for (const entry of refs.slice(0, MAX_REFS_SHOWN)) {
    const tickets = (entry.tickets ?? []).join(', ');
    const label = [`\`${entry.ref.slice(0, 9)}\``, tickets && `(${tickets})`]
      .filter(Boolean)
      .join(' ');
    const shown = entry.files.slice(0, MAX_FILES_SHOWN);
    // "conflicted in 0 files:" followed by nothing is the shape that made a
    // page unreadable — it states a conflict and then lists no evidence for
    // it, while the line below cheerfully reports every file applying cleanly.
    // Say the actual fact instead.
    if (entry.files.length === 0) {
      const total = Number(entry.totalFiles);
      lines.push(
        `${label} — the pick failed but git reported no conflicting file` +
          `${Number.isFinite(total) && total > 0 ? `; all ${total} file${total === 1 ? '' : 's'} in the commit applied cleanly` : ''}.`,
      );
      continue;
    }
    lines.push(
      `${label} — conflicted in ${entry.files.length} file${entry.files.length === 1 ? '' : 's'}:`,
    );
    for (const f of shown) {
      lines.push(`    • \`${f.path}\` — ${f.inert ? 'INERT' : 'CARRIES BEHAVIOR'} (${f.detail})`);
    }
    if (entry.files.length > shown.length) {
      lines.push(`    • …and ${entry.files.length - shown.length} more`);
    }
    // The reassurance that makes an inert verdict legible: naming what DID
    // apply is what separates "one line drifted" from "this fix is broken".
    const clean = Number(entry.totalFiles) - entry.files.length;
    if (Number.isFinite(clean) && clean > 0) {
      lines.push(`    ${clean} other file${clean === 1 ? '' : 's'} in the commit applied cleanly.`);
    }
  }
  if (refs.length > MAX_REFS_SHOWN) {
    lines.push(`…and ${refs.length - MAX_REFS_SHOWN} more ref(s); see the run.`);
  }
  return lines;
}

const MAX_FAILURES_SHOWN = 8;

/**
 * "Why it refused", for a red tier.
 *
 * A `fail` verdict has no conflicting paths among the refs that REACHED the
 * tiers — every survivor cherry-picked cleanly, which is the only way it got
 * there — so `refLines` had nothing to say about the failure itself and the
 * section rendered as a bare heading above an instruction to go read the log.
 * That is the most severe verdict the lane has and it was carrying the least
 * information of any of them. (`refs` can still be non-empty on a `fail`: it
 * holds refs DROPPED before the tiers ran, which `buildSlackPayload` renders
 * under its own heading rather than as the reason the tiers went red.)
 *
 * Naming the failures is also what lets a reader tell the two causes apart
 * without opening anything: a failing test in a package the fixes never touched
 * is the stable being red on its own, not a fix that depends on later work.
 */
function failureLines(failures, verdict) {
  if (verdict === 'could-not-verify') {
    // No lead line: the bullet already carries the budget and the exit code,
    // and a heading restating it was the redundancy the previous commit set out
    // to remove. The `fail` arm's lead earns its place by adding the attempt
    // count; there is nothing equivalent to add here.
    //
    // Which attempt ran out is deliberately not claimed. A first-attempt blow
    // is never retried, but the RETRY can blow its own budget too, so "there
    // was no second attempt" holds on one path and not the other.
    if (failures.length === 0) {
      return ['The tiers ran out of their time budget. Read the run log for where the time went.'];
    }
    return failures.map((f) => `    • ${f}`);
  }
  if (failures.length === 0) {
    // Hedged, because `verdict=fail` has two sites in the workflow: the
    // retry-exhausted tier path, and the `pnpm install --frozen-lockfile`
    // failure that exits BEFORE either attempt runs and so can never populate
    // this list. Asserting "both attempts" would be false in exactly the case
    // that reaches this branch most reliably, which is the same
    // cause-conflation this page is being fixed to stop doing.
    return [
      'The tiers went red on both attempts, or the install itself failed before either ran. This run captured no failing test or task name — read the run log directly.',
    ];
  }
  const shown = failures.slice(0, MAX_FAILURES_SHOWN);
  const lines = ['Failing on the second attempt, so not flake-class:'];
  for (const failure of shown) lines.push(`    • \`${failure}\``);
  if (failures.length > shown.length) {
    lines.push(`    • …and ${failures.length - shown.length} more`);
  }
  lines.push(
    'If none of these sit in code the fixes touch, the stable is red on its own and the lane will refuse every fix until that is repaired.',
  );
  return lines;
}

export function buildSlackPayload({
  verdict,
  stable,
  refs,
  runUrl,
  failures = [],
  repo = DEFAULT_REPO,
}) {
  const { headline, meaning } = describeRefusal({ verdict, refs });
  const summary = `⛔ ${headline}`;
  const body = [
    `*Over \`${stable}\` on \`${repo}\`.* ${meaning}`,
    '',
    '*Why it refused*',
    ...(verdict === 'fail' || verdict === 'could-not-verify'
      ? failureLines(failures, verdict)
      : refLines(refs)),
    // A red tier does not imply an empty `refs`. The pick loop writes its
    // `conflicts` output for every DROPPED ref and then lets the survivors run
    // the tiers, so a partial drop followed by a red tier arrives here with
    // real drop evidence. `refLines` used to render it, badly labelled; the
    // partial-drop page cannot cover the gap because its own step is gated on
    // `verdict == 'pass'`. Losing the labelling problem must not also lose the
    // information, so the drops keep their own heading.
    ...((verdict === 'fail' || verdict === 'could-not-verify') && refs.length > 0
      ? ['', '*Also dropped from this batch, before the tiers ran*', ...refLines(refs)]
      : []),
    '',
    '*What you can do*',
    ...optionsFor({ verdict, refs }).map((o, i) => `${i + 1}. ${o}`),
    '',
    // Only the run link is conditional; the blank separators above are
    // deliberate and must survive.
    ...(runUrl ? [`<${runUrl}|Run log>`] : []),
    '_Further identical refusals stay silent; the lane pages again only if the refusal changes._',
  ].join('\n');

  return {
    // `text` is the notification / a11y fallback Slack recommends alongside blocks.
    text: summary,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: summary, emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: body } },
    ],
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
    repo: args.repo || parsed.repo || DEFAULT_REPO,
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
