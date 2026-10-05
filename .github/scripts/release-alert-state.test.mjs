import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
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

describe('the alarm hands the acknowledgement from the job that restores it to the job that pages', () => {
  const OK_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const { jobs } = parse(readFileSync(join(OK_ROOT, '.github', 'workflows', 'select-beta-to-promote.yml'), 'utf8'));
  const stepRun = (job, name) => {
    const found = jobs[job].steps.filter((step) => step.name === name);
    if (found.length !== 1) throw new Error(`select-beta-to-promote.yml#${job} has ${found.length} steps named ${name}`);
    return found[0].run;
  };
  const handOn = stepRun('read-smoke-incident', 'Hand on the acknowledgement state');
  const write = stepRun('page-smoke-incident', 'Write the handed-over acknowledgement');
  const page = stepRun('page-smoke-incident', 'Page the release channel');

  const readOutputs = (file) => {
    const lines = readFileSync(file, 'utf8').split('\n');
    const outputs = {};
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === '') continue;
      const equals = line.indexOf('=');
      const heredoc = line.indexOf('<<');
      if (heredoc !== -1 && (equals === -1 || heredoc < equals)) {
        const delimiter = line.slice(heredoc + 2);
        const value = [];
        for (i += 1; lines[i] !== delimiter; i += 1) {
          if (i >= lines.length) throw new Error(`no closing ${delimiter}`);
          value.push(lines[i]);
        }
        outputs[line.slice(0, heredoc)] = value.join('\n');
      } else {
        outputs[line.slice(0, equals)] = line.slice(equals + 1);
      }
    }
    return outputs;
  };

  let scratch;
  let server;
  let webhook;
  const received = [];
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'release-alert-handover-'));
    server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      received.push(JSON.parse(body).text);
      response.end('ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    webhook = `http://127.0.0.1:${server.address().port}/slack`;
  });
  afterAll(async () => {
    rmSync(scratch, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  let runs = 0;
  const runStep = async (script, env) => {
    const dir = join(scratch, `step-${(runs += 1)}`);
    mkdirSync(dir);
    const file = join(dir, 'step.sh');
    const output = join(dir, 'github-output');
    writeFileSync(file, script);
    writeFileSync(output, '');
    const { SLACK_RELEASES_WEBHOOK_URL: _r, SLACK_WEBHOOK_URL: _s, GITHUB_OUTPUT: _o, NODE_OPTIONS: _n, ...base } = process.env;
    const { status, stderr } = await new Promise((resolve) => {
      execFile(
        'bash',
        ['--noprofile', '--norc', '-eo', 'pipefail', file],
        {
          cwd: OK_ROOT,
          timeout: 20_000,
          env: { ...base, PATH: `${dirname(process.execPath)}:${base.PATH}`, GITHUB_OUTPUT: output, ...env },
        },
        (error, _stdout, err) => resolve({ status: error ? (error.code ?? error.signal) : 0, stderr: err }),
      );
    });
    return { status, stderr, outputs: status === 0 ? readOutputs(output) : {} };
  };

  const pageWith = async (statePath, alarm) => {
    received.length = 0;
    const res = await runStep(page, {
      SLACK_RELEASES_WEBHOOK_URL: webhook,
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'inkeep/open-knowledge',
      GITHUB_RUN_ID: '1',
      REASONS: alarm.reasons,
      ALERT_INCIDENT: alarm.incident,
      ALERT_STATE_PATH: statePath,
    });
    const saved = existsSync(statePath) && !lstatSync(statePath).isDirectory() ? readFileSync(statePath, 'utf8') : null;
    return { paged: res.status === 0, notified: res.outputs.notified ?? null, sent: [...received], saved, stderr: res.stderr };
  };

  const singleJob = (restored, alarm) => pageWith(restored, alarm);
  const splitJobs = async (restored, alarm) => {
    const handed = await runStep(handOn, { ALERT_STATE_PATH: restored });
    if (handed.status !== 0) return { readerFailed: true };
    const statePath = join(scratch, `paging-${(runs += 1)}.json`);
    const written = await runStep(write, { ALERT_STATE: handed.outputs.state, ALERT_STATE_PATH: statePath });
    if (written.status !== 0) throw new Error(`the write step failed: ${written.stderr}`);
    return pageWith(statePath, alarm);
  };

  const now = Date.now();
  const hour = 3_600_000;
  const incident = { incident: 'Smoke or dispatch', reasons: '3 consecutive fast-tier attempts did not complete successfully' };
  const recovery = { incident: '', reasons: '' };
  const cases = [
    { name: 'no acknowledgement in the cache', state: undefined, alarm: incident },
    { name: 'the same incident acknowledged an hour ago', state: { incident: 'Smoke or dispatch', notifiedAt: now - hour }, alarm: incident },
    { name: 'the same incident acknowledged a day ago', state: { incident: 'Smoke or dispatch', notifiedAt: now - 25 * hour }, alarm: incident },
    { name: 'a different incident acknowledged', state: { incident: 'Download the candidate\'s DMG', notifiedAt: now - hour }, alarm: incident },
    { name: 'an open incident that has now recovered', state: { incident: 'Smoke or dispatch', notifiedAt: now - hour }, alarm: recovery },
    { name: 'a recovery already acknowledged', state: { incident: null, notifiedAt: now - hour }, alarm: recovery },
    { name: 'an acknowledgement with extra keys', state: { incident: 'Smoke or dispatch', notifiedAt: now - hour, extra: 'x' }, alarm: incident },
    { name: 'a pretty-printed acknowledgement', raw: `{\n  "incident": "Smoke or dispatch",\n  "notifiedAt": ${now - hour}\n}\n`, alarm: incident },
    { name: 'a garbled acknowledgement', raw: '{"incident":', alarm: incident },
    { name: 'an empty acknowledgement', raw: '', alarm: incident },
    { name: 'an acknowledgement of the wrong shape', state: { incident: 5, notifiedAt: 0 }, alarm: incident },
    { name: 'an acknowledgement with no timestamp', state: { incident: 'Smoke or dispatch' }, alarm: incident },
    { name: 'an acknowledgement that is not an object', raw: '[1,2]', alarm: incident },
  ];

  test.each(cases)('$name pages exactly as the single job did', async ({ state, raw, alarm }) => {
    const restored = join(scratch, `restored-${(runs += 1)}.json`);
    if (state !== undefined) writeFileSync(restored, JSON.stringify(state));
    if (raw !== undefined) writeFileSync(restored, raw);
    const before = await singleJob(restored, alarm);
    if (state !== undefined) writeFileSync(restored, JSON.stringify(state));
    if (raw !== undefined) writeFileSync(restored, raw);
    if (state === undefined && raw === undefined) rmSync(restored, { force: true });
    const after = await splitJobs(restored, alarm);
    const fresh = (saved) => (saved === null ? null : { ...JSON.parse(saved), notifiedAt: JSON.parse(saved).notifiedAt >= now ? 'now' : JSON.parse(saved).notifiedAt });
    expect({ ...after, saved: after.paged ? fresh(after.saved) : null, stderr: undefined }).toEqual({
      ...before,
      saved: before.paged ? fresh(before.saved) : null,
      stderr: undefined,
    });
    if (!before.paged) expect(after.stderr).toBe(before.stderr);
  });

  test('the cases cover a page, a reminder, a recovery, silence and every rejection', async () => {
    const outcomes = [];
    for (const { name, state, raw, alarm } of cases) {
      const restored = join(scratch, `coverage-${(runs += 1)}.json`);
      if (state !== undefined) writeFileSync(restored, JSON.stringify(state));
      if (raw !== undefined) writeFileSync(restored, raw);
      const { paged, sent, stderr } = await splitJobs(restored, alarm);
      outcomes.push([name, paged ? (sent.length > 0 ? [...sent[0]][0] : 'silent') : /Invalid release alert state/.test(stderr) ? 'invalid' : 'unparseable']);
    }
    expect(Object.fromEntries(outcomes)).toEqual({
      'no acknowledgement in the cache': '🚨',
      'the same incident acknowledged an hour ago': 'silent',
      'the same incident acknowledged a day ago': '🚨',
      'a different incident acknowledged': '🚨',
      'an open incident that has now recovered': '✅',
      'a recovery already acknowledged': 'silent',
      'an acknowledgement with extra keys': 'silent',
      'a pretty-printed acknowledgement': 'silent',
      'a garbled acknowledgement': 'unparseable',
      'an empty acknowledgement': 'unparseable',
      'an acknowledgement of the wrong shape': 'invalid',
      'an acknowledgement with no timestamp': 'invalid',
      'an acknowledgement that is not an object': 'invalid',
    });
  });

  test('a dangling link where the acknowledgement should be reads as no acknowledgement in both shapes', async () => {
    const restored = join(scratch, `dangling-${(runs += 1)}.json`);
    const target = join(scratch, `nowhere-${runs}.json`);
    symlinkSync(target, restored);
    const before = await singleJob(restored, incident);
    rmSync(target, { force: true });
    const after = await splitJobs(restored, incident);
    expect(after.sent).toEqual(before.sent);
    expect(after.sent).toHaveLength(1);
  });

  test('a directory where the acknowledgement should be pages nothing in either shape', async () => {
    const restored = join(scratch, `directory-${(runs += 1)}`);
    mkdirSync(restored);
    const before = await singleJob(restored, incident);
    expect(before).toMatchObject({ paged: false, sent: [] });
    expect(await splitJobs(restored, incident)).toEqual({ readerFailed: true });
  });
});
