#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const ALERT_HEADLINE = 'RELEASE BLOCKED';
const DEFAULT_REPO = 'inkeep/open-knowledge';

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

export function describeBlock({ verdict, blockedBy = '' } = {}) {
  const other = String(blockedBy ?? '').trim();

  if (verdict === 'fail') {
    const { short, detail } = describeVerdict('fail');
    return { subject: `DMG smoke ${short}`, detail, smokePassed: false };
  }

  const smokePassed = verdict === 'pass';

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
    `*Smoke verdict:* \`${verdict}\` — ${detail}`,
    other
      ? smokePassed
        ? `*Why:* ${other} failed. The DMG smoke itself passed (${reason}).`
        : `*Why:* ${other} failed (${reason}).`
      : `*Why:* ${reason}`,
    '*State:* the GitHub Release is still a DRAFT and npm `latest` has NOT moved.',
    `*Recovery (fix the cause above first — re-firing alone repairs nothing):*\n\`${recoveryCommand(tag, repo)}\``,
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
