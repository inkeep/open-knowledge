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
 *     --tag vX.Y.Z --verdict fail|error --reason "…" --run-url "…" [--repo owner/name]
 *
 * Emits the payload as JSON on stdout. Everything is assembled through
 * JSON.stringify, so an interpolated tag or reason containing quotes cannot
 * corrupt the body.
 */

import { pathToFileURL } from 'node:url';

const ALERT_HEADLINE = 'RELEASE BLOCKED';
const DEFAULT_REPO = 'inkeep/open-knowledge';

/**
 * A `fail` means the app itself misbehaved; an `error` means the gate could not
 * reach a verdict. The responder does different things in each case, so the
 * two must never read the same.
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

/** Re-firing the two dispatch events is the whole recovery; nothing needs repair by hand. */
export function recoveryCommand(tag, repo = DEFAULT_REPO) {
  return [
    `gh api -X POST repos/${repo}/dispatches -f event_type=desktop-release`,
    `-F 'client_payload[release_tag]=${tag}' -F 'client_payload[ref]=${tag}'`,
  ].join(' ');
}

function summaryLine(tag, verdict) {
  const { short } = describeVerdict(verdict);
  return `🚨 ${ALERT_HEADLINE}: ${tag} DMG smoke ${short} — nothing shipped`;
}

function bodyLines({ tag, verdict, reason, runUrl, repo }) {
  const { detail } = describeVerdict(verdict);
  return [
    `*Tag:* \`${tag}\``,
    `*Verdict:* \`${verdict}\` — ${detail}`,
    `*Why:* ${reason}`,
    '*State:* the GitHub Release is still a DRAFT and npm `latest` has NOT moved.',
    `*Recovery (re-fire the cascade; no manual repair needed):*\n\`${recoveryCommand(tag, repo)}\``,
    `*Run:* ${runUrl}`,
  ];
}

export function buildSlackPayload({ tag, verdict, reason, runUrl, repo = DEFAULT_REPO }) {
  return {
    // `text` is the notification / a11y fallback Slack recommends alongside blocks.
    text: summaryLine(tag, verdict),
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: summaryLine(tag, verdict), emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: bodyLines({ tag, verdict, reason, runUrl, repo }).join('\n'),
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
