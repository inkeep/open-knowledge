import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createApiExtension } from './api-extension.test-helper.ts';
import type { BootedServer } from './boot.ts';
import {
  bootCompositionRig,
  makeCaptureRes,
  makeSyntheticReq,
  parseProblem,
  rawRequest,
} from './composition-rig.test-helper.ts';
import { createContentFilter } from './content-filter.ts';

let root: string;
let server: BootedServer;

function writeSkill(base: string, path: string, name: string, description = 'before'): void {
  const dir = join(base, path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`,
  );
}

function gitIgnored(base: string, path: string): boolean {
  const result = spawnSync(
    'git',
    ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '-q', path],
    { cwd: base },
  );
  expect(result.error).toBeUndefined();
  expect([0, 1]).toContain(result.status);
  return result.status === 0;
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-skill-tracking-')));
  const result = spawnSync('git', ['init', '-q', root]);
  expect(result.status).toBe(0);
  writeSkill(root, '.agents/skills/open-knowledge', 'open-knowledge');
  writeSkill(root, '.claude/skills/hidden', 'hidden');
  writeFileSync(join(root, '.gitignore'), '.claude/*');
  server = await bootCompositionRig(root, { projectDir: root });
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  rmSync(root, { recursive: true, force: true });
});

async function track(body: object) {
  return rawRequest(server.port, '/api/skill/track-in-git', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'tracking-contract' },
    body: JSON.stringify(body),
  });
}

test('tracking previews without writing and then makes the actual Git path trackable', async () => {
  const path = '.claude/skills/hidden/SKILL.md';
  expect(gitIgnored(root, path)).toBe(true);
  const before = readFileSync(join(root, '.gitignore'), 'utf8');
  const preview = await track({ name: 'hidden', scope: 'project' });
  expect(preview.status, preview.body).toBe(200);
  expect(JSON.parse(preview.body)).toMatchObject({
    line: '!/.claude/skills/',
    gitignorePath: '.gitignore',
    applied: false,
  });
  expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(before);
  const applied = await track({ name: 'hidden', scope: 'project', apply: true });
  expect(applied.status, applied.body).toBe(200);
  expect(applied.headers['x-request-id']).toBe('tracking-contract');
  expect(JSON.parse(applied.body)).toMatchObject({ applied: true });
  expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('.claude/*\n!/.claude/skills/\n');
  expect(gitIgnored(root, path)).toBe(false);
  const list = await rawRequest(server.port, '/api/skills');
  expect(list.status, list.body).toBe(200);
  expect(
    JSON.parse(list.body).skills.find((skill: { name: string }) => skill.name === 'hidden'),
  ).toMatchObject({ name: 'hidden' });
  expect(
    JSON.parse(list.body).skills.find((skill: { name: string }) => skill.name === 'hidden').ignored,
  ).toBeUndefined();
  const repeated = await track({ name: 'hidden', scope: 'project', apply: true });
  expect(repeated.status, repeated.body).toBe(200);
  expect(JSON.parse(repeated.body)).toMatchObject({ applied: false, alreadyTracked: true });
  expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('.claude/*\n!/.claude/skills/\n');
});

afterEach(() => vi.restoreAllMocks());

function isolatedFixture(rule: string | null, withSignal: boolean) {
  const contentDir = mkdtempSync(join(root, 'isolated-'));
  const home = mkdtempSync(join(root, 'home-'));
  writeSkill(contentDir, '.agents/skills/open-knowledge', 'open-knowledge');
  writeSkill(contentDir, '.claude/skills/hidden', 'hidden');
  writeSkill(contentDir, '.ok/skills/probe', 'probe');
  if (rule !== null) writeFileSync(join(contentDir, '.gitignore'), rule);
  const rebuildBytes: Array<string | null> = [];
  const signals: string[] = [];
  const contentFilter = createContentFilter({
    contentDir,
    projectDir: contentDir,
    inPlaceSkillDirs: new Set(['.agents/skills/open-knowledge', '.claude/skills/hidden']),
    onAfterRebuild: () => {
      const path = join(contentDir, '.gitignore');
      rebuildBytes.push(existsSync(path) ? readFileSync(path, 'utf8') : null);
    },
  });
  const extension = createApiExtension({
    contentDir,
    projectDir: contentDir,
    homeDirOverride: home,
    contentFilter,
    hocuspocus: server.serverInstance.hocuspocus,
    sessionManager: server.serverInstance.sessionManager,
    ...(withSignal ? { signalChannel: (channel: string) => signals.push(channel) } : {}),
  });
  return { contentDir, home, contentFilter, extension, rebuildBytes, signals };
}

async function request(
  extension: ReturnType<typeof createApiExtension>,
  path: string,
  body?: object,
) {
  const method = body === undefined ? 'GET' : 'POST';
  const base = makeSyntheticReq({ method, url: path });
  const req = Object.assign(
    Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
    {
      method,
      url: path,
      headers: {
        ...base.headers,
        'content-type': 'application/json',
        'x-request-id': 'tracking-cache',
      },
      socket: base.socket,
    },
  ) as IncomingMessage;
  const { res, captured } = makeCaptureRes();
  await extension.onRequest({ request: req, response: res });
  return captured;
}

async function probeDescription(extension: ReturnType<typeof createApiExtension>) {
  const response = await request(extension, '/api/skills');
  expect(response.status, response.body).toBe(200);
  const body = JSON.parse(response.body) as {
    skills: Array<{ name: string; description?: string }>;
  };
  return body.skills.find((skill) => skill.name === 'probe')?.description;
}

test.each([false, true])(
  'tracking refreshes cached content before TTL with files callback %s',
  async (withSignal) => {
    const r = isolatedFixture('.claude/*', withSignal);
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    expect(await probeDescription(r.extension)).toBe('before');
    r.rebuildBytes.length = 0;
    r.signals.length = 0;
    writeSkill(r.contentDir, '.ok/skills/probe', 'probe', 'after');
    expect(await probeDescription(r.extension)).toBe('before');
    const preview = await request(r.extension, '/api/skill/track-in-git', {
      name: 'hidden',
      scope: 'project',
    });
    expect(preview.status).toBe(200);
    expect(await probeDescription(r.extension)).toBe('before');
    expect(r.rebuildBytes).toEqual([]);
    const applied = await request(r.extension, '/api/skill/track-in-git', {
      name: 'hidden',
      scope: 'project',
      apply: true,
    });
    expect(applied.status, applied.body).toBe(200);
    expect(r.contentFilter.isPathIgnored('.claude/skills/hidden/SKILL.md')).toBe(false);
    expect(r.rebuildBytes).toEqual(['.claude/*\n!/.claude/skills/\n']);
    expect(r.signals).toEqual(withSignal ? ['files'] : []);
    expect(await probeDescription(r.extension)).toBe('after');
    writeSkill(r.contentDir, '.ok/skills/probe', 'probe', 'later');
    const repeated = await request(r.extension, '/api/skill/track-in-git', {
      name: 'hidden',
      scope: 'project',
      apply: true,
    });
    expect(JSON.parse(repeated.body)).toMatchObject({ applied: false, alreadyTracked: true });
    expect(await probeDescription(r.extension)).toBe('after');
    expect(r.rebuildBytes).toHaveLength(1);
    expect(r.signals).toEqual(withSignal ? ['files'] : []);
  },
);

test.each([false, true])(
  'an ineffective rule restores bytes, rebuilds twice and refreshes the cache with files callback %s',
  async (withSignal) => {
    const before = '# preserve\r\n.claude/';
    const r = isolatedFixture(before, withSignal);
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    expect(await probeDescription(r.extension)).toBe('before');
    r.rebuildBytes.length = 0;
    r.signals.length = 0;
    writeSkill(r.contentDir, '.ok/skills/probe', 'probe', 'after');
    expect(await probeDescription(r.extension)).toBe('before');
    const failed = await request(r.extension, '/api/skill/track-in-git', {
      name: 'hidden',
      scope: 'project',
      apply: true,
    });
    expect(failed.status, failed.body).toBe(409);
    expect(failed.headers['x-request-id']).toBe('tracking-cache');
    expect(failed.headers['content-type']).toBe('application/problem+json');
    expect(parseProblem(failed.body).title).toContain('was left unchanged');
    expect(readFileSync(join(r.contentDir, '.gitignore'), 'utf8')).toBe(before);
    expect(r.rebuildBytes).toEqual([`${before}\n!/.claude/skills/\n`, before]);
    expect(r.contentFilter.isPathIgnored('.claude/skills/hidden/SKILL.md')).toBe(true);
    expect(r.signals).toEqual([]);
    expect(await probeDescription(r.extension)).toBe('after');
  },
);

test('an existing ineffective negation refuses without writes, rebuilds or cache invalidation', async () => {
  const before = '.claude/\n!/.claude/skills/\n';
  const r = isolatedFixture(before, true);
  vi.spyOn(Date, 'now').mockReturnValue(100_000);
  expect(await probeDescription(r.extension)).toBe('before');
  r.rebuildBytes.length = 0;
  r.signals.length = 0;
  writeSkill(r.contentDir, '.ok/skills/probe', 'probe', 'after');
  const failed = await request(r.extension, '/api/skill/track-in-git', {
    name: 'hidden',
    scope: 'project',
    apply: true,
  });
  expect(failed.status, failed.body).toBe(409);
  expect(parseProblem(failed.body).title).toContain('is already in .gitignore');
  expect(readFileSync(join(r.contentDir, '.gitignore'), 'utf8')).toBe(before);
  expect(r.rebuildBytes).toEqual([]);
  expect(r.signals).toEqual([]);
  expect(await probeDescription(r.extension)).toBe('before');
});

test('rollback removes a newly created ignore file when an OK ignore rule still excludes the skill', async () => {
  const r = isolatedFixture(null, true);
  writeFileSync(join(r.contentDir, '.okignore'), '.claude/\n');
  await r.contentFilter.rebuildIgnorePatterns();
  expect(r.contentFilter.isPathIgnored('.claude/skills/hidden/SKILL.md')).toBe(true);
  r.rebuildBytes.length = 0;
  const failed = await request(r.extension, '/api/skill/track-in-git', {
    name: 'hidden',
    scope: 'project',
    apply: true,
  });
  expect(failed.status, failed.body).toBe(409);
  expect(existsSync(join(r.contentDir, '.gitignore'))).toBe(false);
  expect(r.rebuildBytes).toEqual(['!/.claude/skills/\n', null]);
  expect(r.signals).toEqual([]);
});

test('filesystem errors and invalid scopes keep their error envelopes without side effects', async () => {
  const r = isolatedFixture('.claude/', true);
  rmSync(join(r.contentDir, '.gitignore'));
  mkdirSync(join(r.contentDir, '.gitignore'));
  const failed = await request(r.extension, '/api/skill/track-in-git', {
    name: 'hidden',
    scope: 'project',
    apply: true,
  });
  expect(failed.status, failed.body).toBe(500);
  expect(parseProblem(failed.body)).toMatchObject({
    type: 'urn:ok:error:internal-server-error',
    title: 'Failed to update .gitignore.',
  });
  expect(failed.headers['x-request-id']).toBe('tracking-cache');
  expect(r.rebuildBytes).toEqual([]);
  expect(r.signals).toEqual([]);
  const invalid = await track({ name: '../invalid', scope: 'project', apply: true });
  expect(invalid.status).toBe(400);
  const global = await track({ name: 'hidden', scope: 'global', apply: true });
  expect(global.status).toBe(400);
  expect(parseProblem(global.body).title).toContain('Only project skills');
});

test('tracking rejects an untrusted origin before reading its body or changing gitignore', async () => {
  const r = isolatedFixture('.claude/*', true);
  const req = makeSyntheticReq({
    method: 'POST',
    url: '/api/skill/track-in-git',
    origin: 'https://untrusted.example',
  });
  const { res, captured } = makeCaptureRes();
  await r.extension.onRequest({ request: req, response: res });
  expect(captured.status).toBe(403);
  expect(req.readableEnded).toBe(false);
  req.destroy();
  expect(readFileSync(join(r.contentDir, '.gitignore'), 'utf8')).toBe('.claude/*');
  expect(r.rebuildBytes).toEqual([]);
  expect(r.signals).toEqual([]);
});
