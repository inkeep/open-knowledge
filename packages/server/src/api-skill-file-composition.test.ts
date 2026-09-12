import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
