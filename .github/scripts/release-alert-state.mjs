/* biome-ignore-all lint/suspicious/noUndeclaredEnvVars: GitHub Actions invokes this entrypoint directly, outside Turbo. */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function notifyReleaseIncident({
  statePath,
  incident,
  text,
  nowMs = Date.now(),
  send,
  reminderMs = 86_400_000,
}) {
  let previous = { incident: null, notifiedAt: 0 };
  try {
    previous = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (
    (previous.incident !== null && typeof previous.incident !== 'string') ||
    !Number.isFinite(previous.notifiedAt)
  )
    throw new Error('Invalid release alert state');
  const changed = previous.incident !== incident;
  const reminder = incident !== null && nowMs - previous.notifiedAt >= reminderMs;
  const notify = changed || reminder;
  if (notify) await send(text);
  writeFileSync(
    statePath,
    JSON.stringify({
      incident,
      notifiedAt: notify ? nowMs : previous.notifiedAt,
    }),
  );
  return { notified: notify };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const webhook = process.env.SLACK_RELEASES_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;
  const { notified } = await notifyReleaseIncident({
    statePath: process.env.ALERT_STATE_PATH,
    incident: process.env.ALERT_INCIDENT || null,
    text: process.env.ALERT_TEXT,
    send: async (text) => {
      if (!webhook)
        throw new Error('No release Slack webhook configured; leaving alert unacknowledged');
      const response = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Slack delivery failed (${response.status})`);
    },
  });
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `notified=${notified}\n`);
}
