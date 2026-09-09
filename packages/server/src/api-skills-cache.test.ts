import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
} from './composition-rig.test-helper.ts';
import { createContentFilter } from './content-filter.ts';

let root: string;
let server: BootedServer;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-skills-cache-'));
  const contentDir = join(root, 'server');
  const builtin = join(contentDir, '.agents/skills/open-knowledge');
  mkdirSync(builtin, { recursive: true });
  writeFileSync(
    join(builtin, 'SKILL.md'),
    '---\nname: open-knowledge\ndescription: Project instructions\n---\n\nProject.\n',
  );
  writeSkill(contentDir, '.ok/skills/alpha', 'listener');
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await server?.destroy();
  rmSync(root, { recursive: true, force: true });
});

function writeSkill(base: string, path: string, description: string): void {
  const dir = join(base, path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: alpha\ndescription: ${description}\n---\n\nBody.\n`,
  );
}

function rig(signal?: (channel: string) => void, withFilter = false) {
  const contentDir = mkdtempSync(join(root, 'project-'));
  const home = mkdtempSync(join(root, 'home-'));
  writeSkill(contentDir, '.ok/skills/alpha', 'before');
  if (withFilter) {
    const builtin = join(contentDir, '.agents/skills/open-knowledge');
    mkdirSync(builtin, { recursive: true });
    writeFileSync(
      join(builtin, 'SKILL.md'),
      '---\nname: open-knowledge\ndescription: Fixture\n---\nBody.\n',
    );
  }
  const contentFilter = withFilter
    ? createContentFilter({ contentDir, projectDir: contentDir })
    : undefined;
  const extension = createApiExtension({
    contentDir,
    projectDir: contentDir,
    homeDirOverride: home,
    contentFilter,
    enableTestRoutes: true,
    hocuspocus: server.serverInstance.hocuspocus,
    sessionManager: server.serverInstance.sessionManager,
    ...(signal ? { signalChannel: signal } : {}),
  });
  return { contentDir, home, extension, contentFilter };
}

async function request(
  extension: ReturnType<typeof createApiExtension>,
  path: string,
  method = 'GET',
  body?: object,
  expectedStatus = 200,
) {
  const base = makeSyntheticReq({ method, url: path });
  const req =
    body === undefined
      ? base
      : (Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
          method,
          url: path,
          headers: { ...base.headers, 'content-type': 'application/json' },
          socket: base.socket,
        }) as IncomingMessage);
  const { res, captured } = makeCaptureRes();
  await extension.onRequest({ request: req, response: res });
  expect(captured.status, captured.body).toBe(expectedStatus);
  return JSON.parse(captured.body) as { skills: Array<{ name: string; description?: string }> };
}

async function description(extension: ReturnType<typeof createApiExtension>) {
  return (await request(extension, '/api/skills')).skills.find((s) => s.name === 'alpha')
    ?.description;
}

test('list hits retain disk content until the exact five second expiry', async () => {
  const r = rig();
  const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  expect(await description(r.extension)).toBe('before');
  writeSkill(r.contentDir, '.ok/skills/alpha', 'after');
  now.mockReturnValue(104_999);
  expect(await description(r.extension)).toBe('before');
  now.mockReturnValue(105_000);
  expect(await description(r.extension)).toBe('after');
});

test.each([false, true])(
  'legacy uninstall files invalidation is conditional on a signal callback: %s',
  async (withSignal) => {
    const signals: string[] = [];
    const r = rig(withSignal ? (channel) => signals.push(channel) : undefined);
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    expect(await description(r.extension)).toBe('before');
    writeSkill(r.contentDir, '.ok/skills/alpha', 'after');
    await request(r.extension, '/api/skill/uninstall', 'POST', { name: 'alpha', scope: 'project' });
    expect(await description(r.extension)).toBe(withSignal ? 'after' : 'before');
    expect(signals).toEqual(withSignal ? ['files'] : []);
  },
);

test('a detected editor fingerprint change refreshes list content before expiry', async () => {
  const r = rig();
  vi.spyOn(Date, 'now').mockReturnValue(100_000);
  expect(await description(r.extension)).toBe('before');
  writeSkill(r.contentDir, '.ok/skills/alpha', 'after');
  mkdirSync(join(r.contentDir, '.cursor'), { recursive: true });
  expect(await description(r.extension)).toBe('after');
});

test('one extension invalidates without changing another extension cache', async () => {
  const a = rig(() => {});
  const b = rig(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(100_000);
  expect(await description(a.extension)).toBe('before');
  expect(await description(b.extension)).toBe('before');
  writeSkill(a.contentDir, '.ok/skills/alpha', 'after');
  writeSkill(b.contentDir, '.ok/skills/alpha', 'after');
  await request(a.extension, '/api/skill/uninstall', 'POST', { name: 'alpha', scope: 'project' });
  expect(await description(a.extension)).toBe('after');
  expect(await description(b.extension)).toBe('before');
});

test('a native delete directly invalidates list content without a files callback', async () => {
  const r = rig();
  vi.spyOn(Date, 'now').mockReturnValue(100_000);
  expect(await description(r.extension)).toBe('before');
  await request(r.extension, '/api/skill?name=alpha&scope=project', 'DELETE');
  expect(await description(r.extension)).toBeUndefined();
});

test('installed reads share the generation invalidated by legacy files signals', async () => {
  const r = rig(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(100_000);
  const before = await request(r.extension, '/api/skills/installed');
  expect(before.skills.some((s) => s.name === 'alpha')).toBe(false);
  const installPath = join(r.home, '.claude/plugins/cache/team/eng/1.0.0');
  writeSkill(installPath, 'skills/alpha', 'installed');
  mkdirSync(join(installPath, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(installPath, '.claude-plugin/plugin.json'),
    JSON.stringify({ name: 'eng', version: '1.0.0' }),
  );
  writeFileSync(
    join(r.home, '.claude/plugins/installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: { 'eng@team': [{ scope: 'user', installPath, version: '1.0.0' }] },
    }),
  );
  const cached = await request(r.extension, '/api/skills/installed');
  expect(cached.skills.some((s) => s.name === 'alpha')).toBe(false);
  await request(r.extension, '/api/skill/uninstall', 'POST', { name: 'alpha', scope: 'project' });
  const refreshed = await request(r.extension, '/api/skills/installed');
  expect(refreshed.skills.some((s) => s.name === 'alpha')).toBe(true);
});

test('the composed listener serves the list and admitted documents from shared skill resolution', async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/skills`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(response.headers.get('x-request-id')).not.toBeNull();
  const body = (await response.json()) as { skills: Array<{ name: string; description?: string }> };
  expect(body.skills.find((s) => s.name === 'alpha')?.description).toBe('listener');
  const docs = await fetch(`http://127.0.0.1:${server.port}/api/documents`);
  expect(docs.status).toBe(200);
  const indexed = (await docs.json()) as { documents: Array<{ docName?: string }> };
  expect(indexed.documents.some((d) => d.docName === '.agents/skills/open-knowledge/SKILL')).toBe(
    true,
  );
});

test('folder artifact writes invalidate the shared list without an optional files signal', async () => {
  const r = rig();
  vi.spyOn(Date, 'now').mockReturnValue(100_000);
  expect(await description(r.extension)).toBe('before');
  writeSkill(r.contentDir, '.ok/skills/alpha', 'after');
  await request(r.extension, '/api/folder-config', 'PUT', {
    path: '',
    frontmatter: { category: 'artifact' },
  });
  expect(await description(r.extension)).toBe('after');
  writeSkill(r.contentDir, '.ok/skills/alpha', 'later');
  await request(r.extension, '/api/folder-config', 'PUT', { path: '' });
  expect(await description(r.extension)).toBe('after');
});

test.each([false, true])(
  'legacy test reset preserves its conditional direct invalidation: reset ignores %s',
  async (resetIgnores) => {
    const r = rig(undefined, true);
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    expect(await description(r.extension)).toBe('before');
    writeSkill(r.contentDir, '.ok/skills/alpha', 'after');
    await request(
      r.extension,
      `/api/test-reset?docName=cache-reset&reset-okignore=${resetIgnores}`,
      'POST',
    );
    expect(await description(r.extension)).toBe(resetIgnores ? 'after' : 'before');
  },
);

test('a list populated across a real rebuild uses completion time and the generation at completion', async () => {
  const r = rig(undefined, true);
  for (let i = 0; i < 120; i += 1) mkdirSync(join(r.contentDir, `directory-${i}`));
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  let completed = false;
  const listing = description(r.extension).then((value) => {
    completed = true;
    return value;
  });
  expect(completed).toBe(false);
  await request(r.extension, '/api/folder-config', 'PUT', {
    path: '',
    frontmatter: { category: 'during-list' },
  });
  expect(completed).toBe(false);
  writeSkill(r.contentDir, '.ok/skills/alpha', 'after');
  clock.mockReturnValue(104_000);
  expect(await listing).toBe('before');
  clock.mockReturnValue(108_999);
  expect(await description(r.extension)).toBe('before');
  clock.mockReturnValue(109_000);
  expect(await description(r.extension)).toBe('after');
});

function addPlugin(home: string): void {
  const installPath = join(home, '.claude/plugins/cache/team/cache-probe/1.0.0');
  writeSkill(installPath, 'skills/alpha', 'plugin');
  mkdirSync(join(installPath, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(installPath, '.claude-plugin/plugin.json'),
    JSON.stringify({ name: 'cache-probe', version: '1.0.0' }),
  );
  writeFileSync(
    join(home, '.claude/plugins/installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: { 'cache-probe@team': [{ scope: 'user', installPath, version: '1.0.0' }] },
    }),
  );
}

test.each([false, true])(
  'partial bulk imports refresh both catalogs without depending on the files callback: %s',
  async (withSignal) => {
    const r = rig(withSignal ? () => {} : undefined);
    mkdirSync(join(r.home, '.claude'));
    mkdirSync(join(r.contentDir, '.claude'));
    const source = mkdtempSync(join(root, 'source-'));
    writeSkill(source, 'alpha', 'source');
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    expect(await description(r.extension)).toBe('before');
    expect((await request(r.extension, '/api/skills/installed')).skills).toEqual([]);
    writeSkill(r.contentDir, '.ok/skills/alpha', 'after');
    addPlugin(r.home);
    expect((await request(r.extension, '/api/skills/installed')).skills).toEqual([]);
    const outcome = await request(r.extension, '/api/skills/import-bulk', 'POST', {
      source,
      skills: ['alpha', 'missing'],
      install: false,
    });
    expect(outcome).toMatchObject({ imported: 1, failed: 1 });
    expect(await description(r.extension)).toBe('after');
    expect((await request(r.extension, '/api/skills/installed')).skills).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'alpha' })]),
    );
  },
);

test.each([false, true])(
  'failed bulk recovery still refreshes catalogs but an early install refusal does not: %s',
  async (withSignal) => {
    const r = rig(withSignal ? () => {} : undefined);
    mkdirSync(join(r.home, '.claude'));
    vi.spyOn(Date, 'now').mockReturnValue(100_000);
    expect(await description(r.extension)).toBe('before');
    expect((await request(r.extension, '/api/skills/installed')).skills).toEqual([]);
    writeSkill(r.contentDir, '.ok/skills/alpha', 'after');
    addPlugin(r.home);
    await request(
      r.extension,
      '/api/skill/install',
      'POST',
      { name: 'absent', scope: 'project', targets: ['cursor'] },
      404,
    );
    expect(await description(r.extension)).toBe('before');
    expect((await request(r.extension, '/api/skills/installed')).skills).toEqual([]);
    const result = await request(r.extension, '/api/skills/reimport-bulk', 'POST', {
      scope: 'project',
      names: ['not-imported', 'INVALID NAME'],
    });
    expect(result).toMatchObject({ updated: 0, failed: 2 });
    expect(await description(r.extension)).toBe('after');
    expect((await request(r.extension, '/api/skills/installed')).skills).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'alpha' })]),
    );
  },
);
