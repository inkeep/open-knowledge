import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';
import { notifyReleaseIncident } from './release-alert-state.mjs';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'release-alert-'));
  dirs.push(dir);
  const sent = [];
  const statePath = join(dir, 'state.json');
  return {
    statePath,
    sent,
    run: (over = {}) =>
      notifyReleaseIncident({
        statePath,
        incident: 'download',
        text: 'download failed',
        nowMs: 1000,
        send: async (text) => sent.push(text),
        ...over,
      }),
  };
}

test('repeated failures stay silent despite changing counts and run URLs', async () => {
  const f = fixture();
  await f.run();
  await f.run({ nowMs: 2000, text: '59 attempts; another run URL' });
  expect(f.sent).toEqual(['download failed']);
});

test('a changed cause, recovery and recurrence each page once', async () => {
  const f = fixture();
  await f.run();
  await f.run({ incident: 'smoke', text: 'smoke failed' });
  await f.run({ incident: null, text: 'recovered' });
  await f.run({ incident: null, text: 'recovered' });
  await f.run();
  expect(f.sent).toEqual(['download failed', 'smoke failed', 'recovered', 'download failed']);
});

test('a persistent incident gets at most one daily reminder', async () => {
  const f = fixture();
  await f.run();
  await f.run({ nowMs: 43_200_000 });
  await f.run({ nowMs: 86_401_000 });
  await f.run({ nowMs: 86_402_000 });
  expect(f.sent).toHaveLength(2);
});

test('failed delivery preserves state and retries on the next observation', async () => {
  const f = fixture();
  await f.run();
  const before = readFileSync(f.statePath, 'utf8');
  await expect(
    f.run({
      incident: null,
      send: async () => {
        throw new Error('Slack down');
      },
    }),
  ).rejects.toThrow('Slack down');
  expect(readFileSync(f.statePath, 'utf8')).toBe(before);
  await f.run({ incident: null, text: 'recovered' });
  expect(f.sent).toEqual(['download failed', 'recovered']);
});

test('initial healthy observation does not announce a recovery', async () => {
  const f = fixture();
  await f.run({ incident: null });
  expect(f.sent).toEqual([]);
});

test('corrupt acknowledgement state fails visibly instead of flooding or claiming recovery', async () => {
  const f = fixture();
  writeFileSync(f.statePath, '{}');
  await expect(f.run()).rejects.toThrow('Invalid release alert state');
  expect(f.sent).toEqual([]);
});

test('the CLI delivers through HTTP, persists success, suppresses repeats and retries failure', async () => {
  const f = fixture();
  const messages = [];
  let status = 500;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    messages.push(JSON.parse(body));
    response.writeHead(status).end(status === 200 ? 'ok' : 'unavailable');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const webhook = `http://127.0.0.1:${server.address().port}/slack`;
  const run = () =>
    promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL('./release-alert-state.mjs', import.meta.url))],
      {
        env: {
          ...process.env,
          ALERT_STATE_PATH: f.statePath,
          GITHUB_OUTPUT: `${f.statePath}.outputs`,
          ALERT_INCIDENT: 'download',
          ALERT_TEXT: 'real HTTP probe',
          SLACK_RELEASES_WEBHOOK_URL: webhook,
          SLACK_WEBHOOK_URL: 'http://127.0.0.1:1/must-not-use',
        },
      },
    );
  try {
    await expect(run()).rejects.toThrow('Slack delivery failed (500)');
    status = 200;
    await run();
    await run();
    expect(messages).toEqual([{ text: 'real HTTP probe' }, { text: 'real HTTP probe' }]);
    expect(readFileSync(`${f.statePath}.outputs`, 'utf8')).toBe('notified=true\nnotified=false\n');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
