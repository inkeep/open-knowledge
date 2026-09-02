#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { gitCleanEnv } from '../../scripts/git-clean-env.mjs';

export const INERT_JSON_KEYS = Object.freeze(new Set(['scripts.test:e2e']));

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

export function changedJsonKeys(before, after) {
  const a = flattenJson(before);
  const b = flattenJson(after);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]).sort();
}

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
  if (parsedAfter.private !== true) {
    return unknown('a published package manifest');
  }
  const keys = changedJsonKeys(parsedBefore, parsedAfter);
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

const classifiedWithNoPaths = (r) => Array.isArray(r.files) && r.files.length === 0;

export function reasonPhrase({ verdict, refs }) {
  if (verdict === 'could-not-verify') return 'verification timeout';
  if (verdict === 'fail') return 'red verification';
  if (refs.length > 0 && refs.every((r) => r.inert)) return 'config drift';
  if (refs.length > 0 && refs.every(classifiedWithNoPaths)) return 'unclear pick failure';
  return 'behavior-carrying conflict';
}

function noActionSentence(verdict) {
  if (verdict === 'could-not-verify') {
    return 'No action needed — the lane retries this batch automatically on its next tick.';
  }
  if (verdict === 'fail') {
    return 'The fix itself needs nothing — it ships in the normal 24h soak lane in a future version.';
  }
  return "No action needed — it rides its cycle's stable.";
}

function refLabel(entry) {
  const tickets = (entry.tickets ?? []).join(', ');
  return [`\`${entry.ref.slice(0, 9)}\``, tickets && `(${tickets})`].filter(Boolean).join(' ');
}

function headlineSubject({ verdict, refs }) {
  if (verdict !== 'conflict' || refs.length === 0) return 'The queued fix(es)';
  const [first, ...rest] = refs;
  const label = refLabel(first);
  return rest.length > 0 ? `${label} and ${rest.length} more` : label;
}

export function buildHeadline({ verdict, refs, stable }) {
  return [
    `Bug lane: ${headlineSubject({ verdict, refs })} did not ship in the fast lane due to ${reasonPhrase({ verdict, refs })}.`,
    `Latest stable remains \`${stable}\`.`,
    noActionSentence(verdict),
  ].join(' ');
}

const MAX_REFS_SHOWN = 5;

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

function failureSummaryLines(failures, verdict) {
  if (verdict === 'could-not-verify') {
    if (failures.length === 0) {
      return [
        'The tiers ran out of their time budget, so nothing was verified about the queued fixes — see the run for where the time went.',
      ];
    }
    const rest = failures.length > 1 ? ` and ${failures.length - 1} more` : '';
    return [`\`${failures[0]}\`${rest} — nothing was verified about the queued fixes.`];
  }
  if (failures.length === 0) {
    return [
      'Both attempts went red, or the install itself failed before either ran — see the run log.',
    ];
  }
  const rest = failures.length > 1 ? ` and ${failures.length - 1} more` : '';
  return [`\`${failures[0]}\`${rest} — not flake-class, failing on the second attempt too.`];
}

export function actionLine({ verdict, refs }) {
  if (verdict === 'could-not-verify') {
    return "If this keeps happening, check the lane's recent runs.";
  }
  if (verdict === 'fail') {
    return 'If a failure is named above, check it against the fixes — one in code no fix touches means the stable is red on its own, which no re-run or smaller commit will clear; one a fix does touch means that fix depends on later work.';
  }
  if (refs.length > 0 && refs.every((r) => r.inert)) {
    return 'The collision is config drift, not a dependency, so the fix is already self-contained. `resolve_paths` does not cover this path, so hand-cutting needs a human decision — see RELEASES.md, "When the conflict is config drift, not a dependency".';
  }
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
    ...((verdict === 'fail' || verdict === 'could-not-verify') && refs.length > 0
      ? ['', '*Also dropped from this batch, before the tiers ran*', ...refSummaryLines(refs)]
      : []),
    '',
    actionLine({ verdict, refs }),
    '',
    ...(runUrl ? [`<${runUrl}|Run log>`] : []),
    '_Further identical refusals stay silent; the lane pages again only if the refusal changes._',
  ].join('\n');

  return {
    text: headline,
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
