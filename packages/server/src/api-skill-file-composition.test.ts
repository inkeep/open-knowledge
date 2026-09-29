import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, rawRequest } from './composition-rig.test-helper.ts';
import * as contributorTracker from './contributor-tracker.ts';

let root: string;
let server: BootedServer;
let home: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-skill-file-contract-'));
  const builtin = join(root, '.agents/skills/open-knowledge');
  mkdirSync(builtin, { recursive: true });
  writeFileSync(
    join(builtin, 'SKILL.md'),
    '---\nname: open-knowledge\ndescription: Project instructions\n---\n\nProject.\n',
  );
  home = mkdtempSync(join(tmpdir(), 'ok-skill-file-home-'));
  mkdirSync(join(home, '.claude'));
  server = await bootCompositionRig(root, { configHomedirOverride: home });
  await server.ready;
}, 60_000);

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await server?.destroy();
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

async function request(path: string, method = 'GET', body?: object) {
  const response = await rawRequest(server.port, path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status, response.body).toBe(200);
  return JSON.parse(response.body);
}

test('reference edits and rename preserve live bytes and writer identity', async () => {
  const attribution = vi.spyOn(contributorTracker, 'recordContributor');
  const name = 'file-contract';
  const skill = await request('/api/skill', 'PUT', {
    name,
    scope: 'project',
    frontmatter: { name, description: 'File contract' },
    body: 'Body.\n',
  });
  const dir = (skill.path as string).slice(0, -9);
  const path = 'references/notes.md';
  const docName = `${dir}/${path.slice(0, -3)}`;
  await request('/api/skill-file', 'PUT', {
    name,
    scope: 'project',
    path,
    content: 'Initial.\n',
    agentId: 'file-writer',
  });
  const session = await server.serverInstance.sessionManager.getSession(
    docName,
    'agent-file-writer',
    { displayName: 'File Writer', colorSeed: 'file-writer' },
  );
  const origins: unknown[] = [];
  const observe = (event: { transaction: { origin: unknown } }) =>
    origins.push(event.transaction.origin);
  session.dc.document.getText('source').observe(observe);
  attribution.mockClear();
  const content = '## Bytes\n\nBackslash \\* and <custom>raw</custom>.  \n\n';
  try {
    const result = await request('/api/skill-file', 'PUT', {
      name,
      scope: 'project',
      path,
      content,
      agentId: 'file-writer',
    });
    expect(result).toMatchObject({ path, kind: 'reference', content: true, created: false });
    expect(session.dc.document.getText('source').toString()).toBe(content);
    expect(readFileSync(join(root, dir, path), 'utf8')).toBe(content);
    expect(origins).toContain(session.origin);
    expect(attribution.mock.calls.map(([doc, writer]) => [doc, writer])).toContainEqual([
      `${dir}/SKILL`,
      'agent-file-writer',
    ]);
  } finally {
    session.dc.document.getText('source').unobserve(observe);
  }
  const oldDocument = session.dc.document;
  attribution.mockClear();
  const renamed = await request('/api/skill-file/rename', 'POST', {
    name,
    scope: 'project',
    from: path,
    to: 'references/renamed.md',
    agentId: 'file-renamer',
  });
  expect(renamed).toMatchObject({
    from: path,
    to: 'references/renamed.md',
    fromDocName: docName,
    toDocName: `${dir}/references/renamed`,
  });
  expect(readFileSync(join(root, dir, 'references/renamed.md'), 'utf8')).toBe(content);
  expect(oldDocument.getMap('lifecycle').get('status')).toBe('deleted-upstream');
  expect(attribution.mock.calls.map(([doc, writer]) => [doc, writer])).toContainEqual([
    `${dir}/SKILL`,
    'agent-file-renamer',
  ]);
  expect((await request(`/api/skill-file?name=${name}&path=references/renamed.md`)).text).toBe(
    content,
  );
  expect(
    (
      await request(
        `/api/skill-file?name=${name}&path=references/renamed.md&agentId=file-writer`,
        'DELETE',
      )
    ).existed,
  ).toBe(true);
  expect(
    (await request(`/api/skill-file?name=${name}&path=references/renamed.md`, 'DELETE')).existed,
  ).toBe(false);
});

test('bundle-file reads retain mutation admission', async () => {
  const response = await rawRequest(server.port, '/api/skill-file?name=missing&path=notes.md', {
    headers: { Origin: 'https://untrusted.example.com' },
  });
  expect(response.status).toBe(403);
});

test('raw bundle writes preserve text, resolve sibling extensions, and reject binary reads', async () => {
  const name = 'raw-file-contract';
  const skill = await request('/api/skill', 'PUT', {
    name,
    scope: 'project',
    frontmatter: { name, description: 'Raw files' },
    body: 'Body.\n',
  });
  const dir = (skill.path as string).slice(0, -9);
  for (const [path, content, kind] of [
    ['scripts/run.sh', '#!/bin/sh\r\nprintf "hello"\r\n', 'script'],
    ['references/example.mdx', '<Example value="raw" />\n\n', 'reference'],
    ['assets/data.txt', 'Unicode: 水\t\r\n', 'file'],
  ]) {
    const written = await request('/api/skill-file', 'PUT', {
      name,
      scope: 'project',
      path,
      content,
    });
    expect(written).toMatchObject({ path, kind, content: false, created: true });
    expect(readFileSync(join(root, dir, path), 'utf8')).toBe(content);
    expect((await request(`/api/skill-file?name=${name}&path=${path}`)).text).toBe(content);
  }
  expect(await request(`/api/skill-file?name=${name}&path=references/example.md`)).toMatchObject({
    path: 'references/example.mdx',
    text: '<Example value="raw" />\n\n',
  });
  writeFileSync(join(root, dir, 'assets/binary.dat'), Buffer.from([0, 255, 10]));
  const binary = await rawRequest(
    server.port,
    `/api/skill-file?name=${name}&path=assets/binary.dat`,
    { headers: { 'X-Request-Id': 'file-binary-contract' } },
  );
  expect(binary.status).toBe(415);
  expect(binary.headers['content-type']).toContain('application/problem+json');
  expect(binary.headers['x-request-id']).toBe('file-binary-contract');
  await request('/api/skill-file/rename', 'POST', {
    name,
    scope: 'project',
    from: 'assets/binary.dat',
    to: 'assets/moved.dat',
  });
  expect(readFileSync(join(root, dir, 'assets/moved.dat'))).toEqual(Buffer.from([0, 255, 10]));
  expect(
    (await request(`/api/skill-file?name=${name}&path=assets/moved.dat`, 'DELETE')).existed,
  ).toBe(true);
});

test('bundle reads withhold VCS, package and OS-artifact entries below the skill root', async () => {
  const name = 'withheld-bundle';
  const skill = await request('/api/skill', 'PUT', {
    name,
    scope: 'project',
    frontmatter: { name, description: 'Withheld entries' },
    body: 'Body.\n',
  });
  const dir = join(root, (skill.path as string).slice(0, -9));
  const token = '[remote "origin"]\n\turl = https://user:secret-token@example.com/r.git\n';
  for (const path of ['.git/config', 'NODE_MODULES/x.md', 'assets/.DS_Store']) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), token);
  }
  writeFileSync(join(dir, 'assets/keep.txt'), 'Keep.\n');

  const got = await request(`/api/skill?name=${name}&scope=project`);
  expect(got.skill.files.map((f: { path: string }) => f.path)).toEqual(['assets/keep.txt']);
  const listed = await request('/api/skills');
  expect(listed.skills.find((s: { name: string }) => s.name === name)?.filePaths).toEqual([
    'assets/keep.txt',
  ]);
  for (const path of ['.git/config', '.GIT/config', 'NODE_MODULES/x.md', 'assets/.DS_Store']) {
    const response = await rawRequest(
      server.port,
      `/api/skill-file?name=${name}&path=${encodeURIComponent(path)}`,
    );
    expect(`${path}=${response.status}`).toBe(`${path}=404`);
  }
  expect((await request(`/api/skill-file?name=${name}&path=assets/keep.txt`)).text).toBe('Keep.\n');
});

test('bundle writes refuse withheld entries below the skill root', async () => {
  const name = 'withheld-writes';
  const skill = await request('/api/skill', 'PUT', {
    name,
    scope: 'project',
    frontmatter: { name, description: 'Withheld writes' },
    body: 'Body.\n',
  });
  const dir = join(root, (skill.path as string).slice(0, -9));
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git/config'), 'Original.\n');
  await request('/api/skill-file', 'PUT', {
    name,
    scope: 'project',
    path: 'assets/keep.txt',
    content: 'Keep.\n',
  });
  const json = { 'Content-Type': 'application/json' };
  const attempts = {
    put: await rawRequest(server.port, '/api/skill-file', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ name, scope: 'project', path: '.GIT/config', content: 'Evil.\n' }),
    }),
    delete: await rawRequest(
      server.port,
      `/api/skill-file?name=${name}&scope=project&path=.git/config`,
      { method: 'DELETE' },
    ),
    rename: await rawRequest(server.port, '/api/skill-file/rename', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        name,
        scope: 'project',
        from: 'assets/keep.txt',
        to: 'node_modules/keep.txt',
      }),
    }),
  };
  const withheldTitle =
    'Skill file path falls under an entry Open Knowledge withholds from skill bundles (.git, node_modules, OK and editor host dirs, OS artifact files).';
  for (const [verb, response] of Object.entries(attempts)) {
    expect(`${verb}=${response.status} ${JSON.parse(response.body).title}`).toBe(
      `${verb}=400 ${withheldTitle}`,
    );
  }
  expect(readFileSync(join(dir, '.git/config'), 'utf-8')).toBe('Original.\n');
  expect(readFileSync(join(dir, 'assets/keep.txt'), 'utf-8')).toBe('Keep.\n');
});

test('bundle reads and writes refuse paths a symlink resolves into a withheld entry or out of the skill', async () => {
  const name = 'linked-bundle';
  const skill = await request('/api/skill', 'PUT', {
    name,
    scope: 'project',
    frontmatter: { name, description: 'Linked entries' },
    body: 'Body.\n',
  });
  const dir = join(root, (skill.path as string).slice(0, -9));
  const outside = mkdtempSync(join(tmpdir(), 'ok-skill-file-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'Outside.\n');
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, '.git/config'), 'Original.\n');
  writeFileSync(join(dir, '.git/HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(dir, '.git/objects'));
  await request('/api/skill-file', 'PUT', {
    name,
    scope: 'project',
    path: 'assets/keep.txt',
    content: 'Keep.\n',
  });
  symlinkSync('.git', join(dir, 'cfg'), 'dir');
  symlinkSync('.git', join(dir, 'references'), 'dir');
  symlinkSync('.git/config', join(dir, 'leaf'), 'file');
  symlinkSync('.git/config', join(dir, 'notes.mdx'), 'file');
  symlinkSync(outside, join(dir, 'ext'), 'dir');
  symlinkSync('.git/newfile', join(dir, 'dangling'), 'file');
  symlinkSync('.git/objects', join(dir, 'y'), 'dir');
  symlinkSync('y/../info/attributes', join(dir, 'dotdot'), 'file');
  try {
    const reads: Record<string, number> = {};
    for (const path of ['cfg/config', 'leaf', 'notes.md', 'ext/secret.txt']) {
      const response = await rawRequest(
        server.port,
        `/api/skill-file?name=${name}&path=${encodeURIComponent(path)}`,
      );
      reads[path] = response.status;
    }
    const put = (path: string) =>
      rawRequest(server.port, '/api/skill-file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, scope: 'project', path, content: 'Evil.\n' }),
      });
    const rename = (from: string, to: string) =>
      rawRequest(server.port, '/api/skill-file/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, scope: 'project', from, to }),
      });
    const writes: Record<string, number> = {
      'put cfg/config': (await put('cfg/config')).status,
      'put references/config.md': (await put('references/config.md')).status,
      'put ext/secret.txt': (await put('ext/secret.txt')).status,
      'put dangling': (await put('dangling')).status,
      'put dotdot': (await put('dotdot')).status,
      'rename to cfg/keep.txt': (await rename('assets/keep.txt', 'cfg/keep.txt')).status,
      'rename cfg/config': (await rename('cfg/config', 'assets/moved.txt')).status,
      'delete cfg/HEAD': (
        await rawRequest(server.port, `/api/skill-file?name=${name}&scope=project&path=cfg/HEAD`, {
          method: 'DELETE',
        })
      ).status,
    };
    expect({ reads, writes }).toEqual({
      reads: { 'cfg/config': 404, leaf: 404, 'notes.md': 404, 'ext/secret.txt': 400 },
      writes: {
        'put cfg/config': 400,
        'put references/config.md': 400,
        'put ext/secret.txt': 400,
        'put dangling': 400,
        'put dotdot': 400,
        'rename to cfg/keep.txt': 400,
        'rename cfg/config': 400,
        'delete cfg/HEAD': 400,
      },
    });
    expect(readFileSync(join(dir, '.git/config'), 'utf-8')).toBe('Original.\n');
    expect(existsSync(join(dir, '.git/HEAD'))).toBe(true);
    expect(existsSync(join(dir, '.git/config.md'))).toBe(false);
    expect(existsSync(join(dir, '.git/keep.txt'))).toBe(false);
    expect(existsSync(join(dir, '.git/newfile'))).toBe(false);
    expect(existsSync(join(dir, '.git/info/attributes'))).toBe(false);
    expect(existsSync(join(dir, 'info/attributes'))).toBe(false);
    expect(readFileSync(join(dir, 'assets/keep.txt'), 'utf-8')).toBe('Keep.\n');
    expect(readFileSync(join(outside, 'secret.txt'), 'utf-8')).toBe('Outside.\n');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('bundle path and size errors leave the existing file unchanged', async () => {
  const name = 'file-errors';
  await request('/api/skill', 'PUT', {
    name,
    scope: 'project',
    frontmatter: { name, description: 'Errors' },
    body: 'Body.\n',
  });
  await request('/api/skill-file', 'PUT', {
    name,
    scope: 'project',
    path: 'assets/keep.txt',
    content: 'Keep.\n',
  });
  for (const body of [
    { path: '../outside.txt', content: 'Escape' },
    { path: 'SKILL.md', content: 'Overwrite' },
    { path: 'assets/keep.txt', content: 'x'.repeat(256 * 1024 + 1) },
  ]) {
    const response = await rawRequest(server.port, '/api/skill-file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, scope: 'project', ...body }),
    });
    expect(response.status, response.body).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
  }
  const missing = await rawRequest(server.port, '/api/skill-file/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      scope: 'project',
      from: 'assets/missing.txt',
      to: 'assets/keep.txt',
    }),
  });
  expect(missing.status).toBe(400);
  expect((await request(`/api/skill-file?name=${name}&path=assets/keep.txt`)).text).toBe('Keep.\n');
});
