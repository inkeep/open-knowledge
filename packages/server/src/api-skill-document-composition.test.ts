import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, rawRequest } from './composition-rig.test-helper.ts';
import * as contributorTracker from './contributor-tracker.ts';
import { moveSkillCrossScope } from './mcp/tools/skill-target.ts';

let root: string;
let server: BootedServer;
let home: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ok-skill-document-contract-'));
  const builtin = join(root, '.agents/skills/open-knowledge');
  mkdirSync(builtin, { recursive: true });
  writeFileSync(
    join(builtin, 'SKILL.md'),
    '---\nname: open-knowledge\ndescription: Project instructions\n---\n\nProject.\n',
  );
  home = mkdtempSync(join(tmpdir(), 'ok-skill-document-home-'));
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

test('create, edit, list and delete retain disk bytes and the editing session origin', async () => {
  const attribution = vi.spyOn(contributorTracker, 'recordContributor');
  const name = 'document-contract';
  const created = await request('/api/skill', 'PUT', {
    name,
    scope: 'project',
    frontmatter: { name, description: 'Before' },
    body: 'Initial.\n',
    agentId: 'document-writer',
  });
  expect(created.created).toBe(true);
  const path = created.path as string;
  const docName = path.slice(0, -3);
  const session = await server.serverInstance.sessionManager.getSession(
    docName,
    'agent-document-writer',
    { displayName: 'Document Writer', colorSeed: 'document-writer' },
  );
  const origins: unknown[] = [];
  const observe = (event: { transaction: { origin: unknown } }) =>
    origins.push(event.transaction.origin);
  session.dc.document.getText('source').observe(observe);
  attribution.mockClear();
  try {
    const body = '## Exact bytes\n\nBackslash \\* and <custom data="x">raw</custom>.\n\n';
    const edited = await request('/api/skill', 'PUT', {
      name,
      scope: 'project',
      frontmatter: { name, description: 'After' },
      body,
      agentId: 'document-writer',
      agentName: 'Document Writer',
    });
    expect(edited.created).toBe(false);
    const expected = `---\nname: ${name}\ndescription: After\n---\n${body}`;
    expect(session.dc.document.getText('source').toString()).toBe(expected);
    expect(readFileSync(join(root, path), 'utf8')).toBe(expected);
    expect(origins).toContain(session.origin);
    expect(attribution.mock.calls.map(([doc, writer]) => [doc, writer])).toContainEqual([
      docName,
      'agent-document-writer',
    ]);
    const read = await request(`/api/skill?name=${name}&scope=project`);
    expect(read.skill.frontmatter.description).toBe('After');
    expect(read.skill.body).toBe(body);
    const listed = await request('/api/skills');
    expect(listed.skills.find((skill: { name: string }) => skill.name === name)?.description).toBe(
      'After',
    );
  } finally {
    session.dc.document.getText('source').unobserve(observe);
  }
  const deleted = await request(
    `/api/skill?name=${name}&scope=project&agentId=document-writer`,
    'DELETE',
  );
  expect(deleted.existed).toBe(true);
  const listed = await request('/api/skills');
  expect(listed.skills.some((skill: { name: string }) => skill.name === name)).toBe(false);
});

test('mixed-method skill reads retain mutation admission', async () => {
  const response = await rawRequest(server.port, '/api/skill?name=missing', {
    headers: { Origin: 'https://untrusted.example.com' },
  });
  expect(response.status).toBe(403);
});

test('duplicate, rename and scope round trips preserve bundled bytes and remove prior paths', async () => {
  const name = 'directory-contract';
  const created = await request('/api/skill', 'PUT', {
    name,
    scope: 'project',
    frontmatter: { name, description: 'Directory contract' },
    body: 'Body with <raw> and trailing space.  \n',
  });
  const dir = join(root, (created.path as string).slice(0, -9));
  mkdirSync(join(dir, 'scripts'));
  const bytes = Buffer.from([0, 255, 127, 13, 10]);
  writeFileSync(join(dir, 'scripts/data.bin'), bytes);
  await request('/api/skill/duplicate', 'POST', {
    name,
    toName: 'directory-copy',
    scope: 'project',
  });
  await request('/api/skill', 'POST', {
    fromName: 'directory-copy',
    toName: 'directory-renamed',
    scope: 'project',
  });
  const renamed = await request('/api/skill?name=directory-renamed&scope=project');
  const renamedPath = renamed.skill.path as string;
  expect(readFileSync(join(root, renamedPath.slice(0, -9), 'scripts/data.bin'))).toEqual(bytes);
  const before = readFileSync(join(root, renamedPath), 'utf8');
  const global = await request('/api/skill/move-scope', 'POST', {
    name: 'directory-renamed',
    fromScope: 'project',
    toScope: 'global',
  });
  expect(readFileSync(join(home, global.path, 'SKILL.md'), 'utf8')).toBe(before);
  expect(readFileSync(join(home, global.path, 'scripts/data.bin'))).toEqual(bytes);
  const back = await request('/api/skill/move-scope', 'POST', {
    name: 'directory-renamed',
    fromScope: 'global',
    toScope: 'project',
  });
  expect(readFileSync(join(root, back.path, 'SKILL.md'), 'utf8')).toBe(before);
  expect(readFileSync(join(root, back.path, 'scripts/data.bin'))).toEqual(bytes);
  const missing = await rawRequest(server.port, '/api/skill?name=directory-copy&scope=project');
  expect(missing.status).toBe(404);
  await request('/api/skill?name=directory-renamed&scope=project', 'DELETE');
  await request(`/api/skill?name=${name}&scope=project`, 'DELETE');
});

test('external editing resolves a real skill directory without launching an editor', async () => {
  const dir = join(home, 'external');
  mkdirSync(dir);
  writeFileSync(
    join(dir, 'SKILL.md'),
    '---\nname: external\ndescription: External contract\n---\nRaw body.\n',
  );
  const result = await request('/api/skill/edit-external', 'POST', { name: 'external', home: dir });
  expect(result.docName).toBe('__extskill__/external');
});

test.each(['same-storage', 'plain-collision'])(
  'cross-scope %s refusal retains server detail and teaches repair before retry',
  async (refusal) => {
    const name = `move-${refusal}`;
    const created = await request('/api/skill', 'PUT', {
      name,
      scope: 'project',
      frontmatter: { name, description: 'Source skill' },
      body: 'Source bytes.\n',
    });
    const sourcePath = join(root, created.path as string);
    const destinationDir = join(home, '.claude/skills', name);
    if (refusal === 'same-storage') {
      mkdirSync(dirname(destinationDir), { recursive: true });
      symlinkSync(dirname(sourcePath), destinationDir, 'dir');
    } else {
      const destination = await request('/api/skill', 'PUT', {
        name,
        scope: 'global',
        frontmatter: { name, description: 'Destination skill' },
        body: 'Destination bytes.\n',
      });
      expect(join(home, destination.path as string)).toBe(join(destinationDir, 'SKILL.md'));
    }
    const destinationPath = join(destinationDir, 'SKILL.md');
    const sourceBefore = readFileSync(sourcePath, 'utf8');
    const destinationBefore = readFileSync(destinationPath, 'utf8');
    const response = await rawRequest(server.port, '/api/skill/move-scope', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, fromScope: 'project', toScope: 'global' }),
    });
    expect(response.status, response.body).toBe(409);
    const problem = JSON.parse(response.body);
    expect(problem).toMatchObject({
      type: 'urn:ok:error:doc-already-exists',
      moveState: 'nothing-written',
      detail:
        refusal === 'same-storage'
          ? 'SAME_STORAGE'
          : 'Delete or rename it first; this move will not overwrite it.',
    });
    expect(problem).not.toHaveProperty('retentionLedger');

    const result = await moveSkillCrossScope(`http://127.0.0.1:${server.port}`, {
      fromName: name,
      toName: name,
      fromScope: 'project',
      toScope: 'global',
    });
    const text = result.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, moveState: 'nothing-written' });
    expect(text).toContain(problem.detail);
    expect(text).toContain('safe to retry once the refusal is addressed');
    expect(text).not.toContain('occupant is unverified');
    expect(readFileSync(sourcePath, 'utf8')).toBe(sourceBefore);
    expect(readFileSync(destinationPath, 'utf8')).toBe(destinationBefore);
  },
);
