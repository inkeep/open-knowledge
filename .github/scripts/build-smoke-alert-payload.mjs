#!/usr/bin/env node
/**
 * Alert payloads for a blocked release (FR5c).
 *
 * When the DMG smoke gate refuses a release, the operator needs to learn it
 * from the channel they already watch, not by noticing that a release never
 * appeared. This builds the Slack payload for that page.
 *
 * Slack is the only recipient. Discord is the public community server, open to
 * users and to anyone evaluating OpenKnowledge, and it carries shipped
 * releases only.
 *
 * The alert must be UNMISTAKABLY different from the routine
 * "🎉 OpenKnowledge X.Y.Z released" announcement that posts to the same
 * channel: different emoji, different headline, and an explicit statement that
 * nothing shipped. A reader scanning the channel has to be able to tell a
 * blocked release from a successful one at a glance.
 *
 * Usage:
 *   node build-smoke-alert-payload.mjs \
 *     --tag vX.Y.Z --verdict pass|fail|error --reason "…" --run-url "…" \
 *     [--blocked-by "Linux packaging"] [--repo owner/name]
 *
 * `--verdict` is the SMOKE's verdict; `--blocked-by` names the jobs that
 * actually failed. They differ whenever a non-mac packaging job fails while the
 * smoke passes, and conflating them mislabels the page.
 *
 * Emits the payload as JSON on stdout. Everything is assembled through
 * JSON.stringify, so an interpolated tag or reason containing quotes cannot
 * corrupt the body.
 */

import { pathToFileURL } from 'node:url';

const ALERT_HEADLINE = 'RELEASE BLOCKED';
const DEFAULT_REPO = 'inkeep/open-knowledge';

/**
 * The smoke's own view of itself: a `fail` means the app misbehaved, anything
 * else means it could not reach a verdict. The responder does different things
 * in each case, so the two must never read the same.
 *
 * This describes the SMOKE only. What blocked the RELEASE is a wider question —
 * see describeBlock, which is what the headline is built from.
 */
export function describeVerdict(verdict) {
  if (verdict === 'fail') {
    return {
      short: 'FAILED',
      detail: 'the packaged app failed the smoke subset — treat this as a real product regression',
    };
  }
  return {
    short: 'ERRORED',
    detail:
      'the gate hit an infrastructure error and never reached a verdict — the app may be fine; re-run before assuming a regression',
  };
}

/**
 * What actually blocked the release, which is NOT always the smoke.
 *
 * The packaging jobs are independent: Linux or Windows can fail while the mac
 * job runs the smoke to a clean PASS. Attributing every blocked release to the
 * smoke produced pages reading "DMG smoke ERRORED — all 13 executed smoke tests
 * passed", which sent responders hunting a regression that did not exist. A
 * passing smoke must never be rendered as a smoke failure or a smoke error.
 */
export function describeBlock({ verdict, blockedBy = '' } = {}) {
  const other = String(blockedBy ?? '').trim();

  // A genuine smoke failure IS the story, so it keeps the headline even when a
  // blocking stage is known — naming a job there would dilute a real product
  // regression into a pipeline complaint.
  if (verdict === 'fail') {
    const { short, detail } = describeVerdict('fail');
    return { subject: `DMG smoke ${short}`, detail, smokePassed: false };
  }

  const smokePassed = verdict === 'pass';

  // Whenever the workflow knows which job failed, say so. This covers the
  // pass case AND the no-verdict case: when build-macos dies before the smoke
  // runs, the verdict is empty but the failing job is known, and describing
  // that as an error "inside the gate" points the responder at a gate that
  // never ran — while the annotation and jq fallback name the job correctly.
  if (other) {
    return {
      subject: `blocked by ${other}`,
      detail: smokePassed
        ? `the DMG smoke PASSED — this is NOT an app regression. ${other} failed; check that job before re-running.`
        : `${other} failed; the DMG smoke never reached a verdict. Check that job before re-running.`,
      smokePassed,
    };
  }

  if (smokePassed) {
    return {
      subject: 'blocked after the smoke passed',
      detail:
        'the DMG smoke PASSED — this is NOT an app regression; a later stage of the release pipeline failed. See the run.',
      smokePassed: true,
    };
  }

  const { short, detail } = describeVerdict(verdict);
  return { subject: `DMG smoke ${short}`, detail, smokePassed: false };
}

/** Re-firing the two dispatch events is the whole recovery; nothing needs repair by hand. */
export function recoveryCommand(tag, repo = DEFAULT_REPO) {
  return [
    `gh api -X POST repos/${repo}/dispatches -f event_type=desktop-release`,
    `-F 'client_payload[release_tag]=${tag}' -F 'client_payload[ref]=${tag}'`,
  ].join(' ');
}

function summaryLine(tag, verdict, blockedBy) {
  const { subject } = describeBlock({ verdict, blockedBy });
  return `🚨 ${ALERT_HEADLINE}: ${tag} ${subject} — nothing shipped`;
}

function bodyLines({ tag, verdict, reason, runUrl, repo, blockedBy }) {
  const { detail, smokePassed } = describeBlock({ verdict, blockedBy });
  const other = String(blockedBy ?? '').trim();
  return [
    `*Tag:* \`${tag}\``,
    // Labelled as the SMOKE's verdict, not the release's: on a Linux or Windows
    // packaging failure the smoke can legitimately read `pass` on a blocked release.
    `*Smoke verdict:* \`${verdict}\` — ${detail}`,
    // Leading with the smoke's own reason is what made the page
    // self-contradictory, so a known blocking stage always comes first — on the
    // no-verdict path too, where the reason describes a gate that never ran.
    other
      ? smokePassed
        ? `*Why:* ${other} failed. The DMG smoke itself passed (${reason}).`
        : `*Why:* ${other} failed (${reason}).`
      : `*Why:* ${reason}`,
    '*State:* the GitHub Release is still a DRAFT and npm `latest` has NOT moved.',
    `*Recovery (re-fire the cascade; no manual repair needed):*\n\`${recoveryCommand(tag, repo)}\``,
    `*Run:* ${runUrl}`,
  ];
}

export function buildSlackPayload({
  tag,
  verdict,
  reason,
  runUrl,
  repo = DEFAULT_REPO,
  blockedBy = '',
}) {
  return {
    // `text` is the notification / a11y fallback Slack recommends alongside blocks.
    text: summaryLine(tag, verdict, blockedBy),
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: summaryLine(tag, verdict, blockedBy), emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: bodyLines({ tag, verdict, reason, runUrl, repo, blockedBy }).join('\n'),
        },
      },
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
  if (!args.tag) throw new Error('--tag is required');
  return {
    tag: args.tag,
    verdict: args.verdict || 'error',
    reason: args.reason || '(no reason recorded)',
    runUrl: args['run-url'] || '',
    repo: args.repo || DEFAULT_REPO,
    // Human-readable names of the jobs that actually failed, when the caller
    // knows them. Absent, the alert falls back to describing the smoke alone.
    blockedBy: args['blocked-by'] || '',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(JSON.stringify(buildSlackPayload(parseArgs(process.argv))));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
