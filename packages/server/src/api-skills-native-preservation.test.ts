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
import { PassThrough } from 'node:stream';
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
import { buildIngressPolicy } from './ingress-policy.ts';

const FAMILIES = {
  'skills-list': ['/api/skills'],
  'skills-document': [
    '/api/skill',
    '/api/skill/edit-external',
    '/api/skill/duplicate',
    '/api/skill/move-scope',
  ],
  'skills-file': ['/api/skill-file', '/api/skill-file/rename'],
  'skills-import': ['/api/skill/import', '/api/skills/import-bulk', '/api/skill-upload'],
  'skills-install': ['/api/skill/install'],
  'handoff-install': ['/api/install-skill'],
  'skills-recovery': [
    '/api/skill/restore',
    '/api/skill/reimport',
    '/api/skills/reimport-bulk',
    '/api/skill/revert',
  ],
  'skills-tracking': ['/api/skill/track-in-git'],
} as const;
const PATHS = Object.values(FAMILIES).flat();
let root: string;
let server: BootedServer;
let ephemeral: BootedServer;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ok-skills-native-preservation-')));
  const contentDir = join(root, 'normal');
  const builtin = join(contentDir, '.agents/skills/open-knowledge');
  mkdirSync(builtin, { recursive: true });
  writeFileSync(
    join(builtin, 'SKILL.md'),
    '---\nname: open-knowledge\ndescription: Fixture\n---\nBody.\n',
  );
  server = await bootCompositionRig(contentDir, { projectDir: contentDir });
  await server.ready;
  const single = join(root, 'ephemeral');
  mkdirSync(single);
  writeFileSync(join(single, 'note.md'), '# Note\n');
  ephemeral = await bootCompositionRig(single, { ephemeral: true, singleDocRelPath: 'note.md' });
  await ephemeral.ready;
}, 60_000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await Promise.allSettled([server?.destroy(), ephemeral?.destroy()]);
  rmSync(root, { recursive: true, force: true });
});

test('all seventeen paths have exclusive native ownership while uninstall remains legacy', async () => {
  expect(PATHS).toHaveLength(17);
  const nativePaths = server.serverInstance.nativeApi.paths;
  for (const path of PATHS)
    expect(
      nativePaths.filter((entry) => entry === path),
      path,
    ).toHaveLength(1);
  expect(nativePaths).not.toContain('/api/skill/uninstall');
  const uninstalled = await rawRequest(server.port, '/api/skill/uninstall', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'missing', scope: 'project' }),
  });
  expect(uninstalled.status, uninstalled.body).toBe(200);
});

test('every native family preserves Host, Origin and forwarded-header refusal over the listener', async () => {
  for (const path of PATHS) {
    for (const [headers, type] of [
      [{ Host: 'evil.example' }, 'urn:ok:error:host-not-allowed'],
      [{ Origin: 'https://evil.example' }, 'urn:ok:error:invalid-origin'],
      [{ 'X-Forwarded-For': '127.0.0.1' }, 'urn:ok:error:host-not-allowed'],
    ] as const) {
      const response = await rawRequest(server.port, path, {
        method: 'PATCH',
        headers: { ...headers, 'X-Request-Id': 'skills-admission' },
      });
      expect(response.status, `${path}: ${response.body}`).toBe(403);
      expect(response.headers.allow).toBeUndefined();
      expect(response.headers['content-type']).toBe('application/problem+json');
      expect(response.headers['x-request-id']).toBe(
        'X-Forwarded-For' in headers ? undefined : 'skills-admission',
      );
      expect(parseProblem(response.body).type).toBe(type);
    }
  }
});

function extension(options: { external?: boolean; ephemeral?: boolean } = {}) {
  return createApiExtension({
    contentDir: join(root, 'normal'),
    projectDir: join(root, 'normal'),
    homeDirOverride: join(root, 'home'),
    hocuspocus: server.serverInstance.hocuspocus,
    sessionManager: server.serverInstance.sessionManager,
    ephemeral: options.ephemeral,
    ...(options.external
      ? {
          ingressPolicy: buildIngressPolicy({
            serverRuntime: {
              bind: ['127.0.0.1'],
              port: 0,
              externalUrl: 'https://skills.example.com',
              allowExternal: true,
              openBrowser: false,
              idleShutdown: 'off',
              loopbackOnly: false,
            },
          }),
        }
      : {}),
  });
}

test('non-loopback peers are refused before parsing on all paths, while configured external peers reach dispatch', async () => {
  const local = extension();
  const external = extension({ external: true });
  for (const path of PATHS) {
    for (const [api, consented] of [
      [local, false],
      [external, true],
    ] as const) {
      const req = makeSyntheticReq({
        method: 'PATCH',
        url: path,
        remoteAddress: '203.0.113.8',
        host: consented ? 'skills.example.com' : '127.0.0.1',
      });
      const { res, captured } = makeCaptureRes();
      expect(await api.nativeApi.dispatch(req, res)).toBe(true);
      expect(captured.status, `${path}: ${captured.body}`).toBe(consented ? 405 : 403);
      expect(parseProblem(captured.body).type).toBe(
        consented
          ? path === '/api/skill-upload'
            ? 'urn:ok:error:invalid-request'
            : 'urn:ok:error:method-not-allowed'
          : 'urn:ok:error:loopback-required',
      );
      expect(req.readableEnded).toBe(false);
      req.destroy();
    }
  }
});

test('ephemeral admission still rejects hostile Hosts and retains the existing method surface', async () => {
  for (const path of PATHS) {
    const refused = await rawRequest(ephemeral.port, path, {
      method: 'PATCH',
      headers: { Host: 'evil.example' },
    });
    expect(refused.status, `${path}: ${refused.body}`).toBe(403);
    const admitted = await rawRequest(ephemeral.port, path, { method: 'PATCH' });
    expect(admitted.status, `${path}: ${admitted.body}`).toBe(405);
  }
  const restricted = await rawRequest(ephemeral.port, '/api/folder-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '', frontmatter: { category: 'refused' } }),
  });
  expect(restricted.status, restricted.body).toBe(403);
  expect(parseProblem(restricted.body).type).toBe('urn:ok:error:single-file-mode');
  expect(existsSync(join(root, 'ephemeral/.ok/frontmatter.yml'))).toBe(false);
});

test.each(['timeout', 'disconnect'] as const)(
  'interrupted skill JSON bodies preserve %s handling without writing content',
  async (kind) => {
    const controller = new AbortController();
    const deadlines: number[] = [];
    const reading = Promise.withResolvers<void>();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      deadlines.push(milliseconds);
      reading.resolve();
      return controller.signal;
    });
    const base = makeSyntheticReq({ method: 'PUT', url: '/api/skill' });
    const stream = new PassThrough();
    const req = Object.assign(stream, {
      method: 'PUT',
      url: '/api/skill',
      headers: { ...base.headers, 'content-type': 'application/json' },
      socket: base.socket,
    }) as IncomingMessage;
    const { res, captured } = makeCaptureRes();
    const pending = extension().nativeApi.dispatch(req, res);
    stream.write('{"name":"interrupted","body":"unfinished');
    await reading.promise;
    expect(deadlines).toEqual([30_000]);
    if (kind === 'timeout') controller.abort();
    else stream.destroy();
    expect(await pending).toBe(true);
    expect(captured.status, captured.body).toBe(kind === 'timeout' ? 408 : 500);
    expect(parseProblem(captured.body)).toMatchObject({
      type:
        kind === 'timeout' ? 'urn:ok:error:request-timeout' : 'urn:ok:error:internal-server-error',
      title: kind === 'timeout' ? 'Request body read timed out.' : 'Failed to read request body.',
    });
    expect(existsSync(join(root, 'normal/.agents/skills/interrupted/SKILL.md'))).toBe(false);
    expect(existsSync(join(root, 'normal/.ok/skills/interrupted/SKILL.md'))).toBe(false);
    req.destroy();
  },
);

test('real live skill and reference conflicts refuse edits and rename without changing either source', async () => {
  const name = 'conflicted-skill';
  const post = (path: string, method: string, body: object) =>
    rawRequest(server.port, path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const created = await post('/api/skill', 'PUT', {
    name,
    scope: 'project',
    frontmatter: { name, description: 'Before' },
    body: 'Keep this body.\n',
    agentId: 'conflict-writer',
  });
  expect(created.status, created.body).toBe(200);
  const path = JSON.parse(created.body).path as string;
  const docName = path.slice(0, -3);
  const file = 'references/note.md';
  const reference = await post('/api/skill-file', 'PUT', {
    name,
    scope: 'project',
    path: file,
    content: 'Reference bytes.  \n',
    agentId: 'conflict-writer',
  });
  expect(reference.status, reference.body).toBe(200);
  const referenceDocName = `${docName.slice(0, -5)}${file.slice(0, -3)}`;
  for (const current of [docName, referenceDocName]) {
    const session = await server.serverInstance.sessionManager.getSession(
      current,
      'agent-conflict-writer',
      { displayName: 'Conflict Writer', colorSeed: 'conflict-writer' },
    );
    session.dc.document.transact(
      () => session.dc.document.getMap('lifecycle').set('status', 'conflict'),
      session.origin,
    );
  }
  const skillBefore = readFileSync(join(root, 'normal', path), 'utf8');
  const referenceBefore = readFileSync(join(root, 'normal', `${referenceDocName}.md`), 'utf8');
  for (const [route, method, body] of [
    [
      '/api/skill',
      'PUT',
      {
        name,
        scope: 'project',
        frontmatter: { name, description: 'After' },
        body: 'Forbidden edit.',
      },
    ],
    [
      '/api/skill-file',
      'PUT',
      { name, scope: 'project', path: file, content: 'Forbidden reference edit.' },
    ],
    [
      '/api/skill-file/rename',
      'POST',
      { name, scope: 'project', from: file, to: 'references/moved.md' },
    ],
  ] as const) {
    const refused = await post(route, method, body);
    expect(refused.status, `${route}: ${refused.body}`).toBe(409);
    expect(parseProblem(refused.body).type).toBe('urn:ok:error:doc-in-conflict');
  }
  expect(readFileSync(join(root, 'normal', path), 'utf8')).toBe(skillBefore);
  expect(readFileSync(join(root, 'normal', `${referenceDocName}.md`), 'utf8')).toBe(
    referenceBefore,
  );
  expect(
    server.serverInstance.hocuspocus.documents.get(docName)?.getText('source').toString(),
  ).toBe(skillBefore);
  expect(
    server.serverInstance.hocuspocus.documents.get(referenceDocName)?.getText('source').toString(),
  ).toBe(referenceBefore);
  expect(existsSync(join(root, 'normal', `${docName.slice(0, -5)}references/moved.md`))).toBe(
    false,
  );
});

test('the retained local dispatcher imports and installs through the native tables in a real authoring round trip', async () => {
  const name = 'local-round-trip';
  const source = join(root, 'source', name);
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Original\n---\nOriginal bytes.\n`,
  );
  const imported = await server.serverInstance.localApi('POST', '/api/skill/import', {
    body: JSON.stringify({ source, install: false, agentId: 'local-importer' }),
    contentType: 'application/json',
  });
  expect(imported?.status, imported?.bodyText).toBe(200);
  const edited = await rawRequest(server.port, '/api/skill', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      scope: 'project',
      frontmatter: { name, description: 'Edited' },
      body: 'Exact \\* and <custom>raw</custom>.  \n\n',
      agentId: 'local-editor',
    }),
  });
  expect(edited.status, edited.body).toBe(200);
  const path = JSON.parse(edited.body).path as string;
  const bytes = readFileSync(join(root, 'normal', path), 'utf8');
  expect(bytes).toBe(
    `---\nname: ${name}\ndescription: Edited\n---\nExact \\* and <custom>raw</custom>.  \n\n`,
  );
  const listing = await rawRequest(server.port, '/api/skills');
  expect(listing.status, listing.body).toBe(200);
  expect(JSON.parse(listing.body).skills).toEqual(
    expect.arrayContaining([expect.objectContaining({ name, description: 'Edited' })]),
  );
  const installed = await server.serverInstance.localApi('POST', '/api/skill/install', {
    body: JSON.stringify({ name, scope: 'project', targets: ['cursor'] }),
    contentType: 'application/json',
  });
  expect(installed?.status, installed?.bodyText).toBe(200);
  expect(readFileSync(join(root, 'normal/.cursor/skills', name, 'SKILL.md'), 'utf8')).toBe(bytes);
  const deleted = await rawRequest(
    server.port,
    `/api/skill?name=${name}&scope=project&agentId=local-editor`,
    { method: 'DELETE' },
  );
  expect(deleted.status, deleted.body).toBe(200);
  expect(existsSync(join(root, 'normal', path))).toBe(false);
  expect(existsSync(join(root, 'normal/.cursor/skills', name, 'SKILL.md'))).toBe(false);
});

test('consented external forwarding reaches each native method gate on the composed listener', async () => {
  const contentDir = join(root, 'external');
  mkdirSync(contentDir);
  const external = await bootCompositionRig(contentDir, {
    serverRuntime: {
      bind: ['127.0.0.1'],
      port: 0,
      externalUrl: 'https://skills.example.com',
      allowExternal: true,
      openBrowser: false,
      idleShutdown: 'off',
      loopbackOnly: true,
    },
  });
  try {
    await external.ready;
    for (const path of PATHS) {
      const response = await rawRequest(external.port, path, {
        method: 'PATCH',
        headers: {
          Host: 'skills.example.com',
          Origin: 'https://skills.example.com',
          'X-Forwarded-For': '203.0.113.8',
          'X-Request-Id': 'consented-skills',
        },
      });
      expect(response.status, `${path}: ${response.body}`).toBe(405);
      expect(response.headers['x-request-id']).toBe('consented-skills');
      expect(response.headers['access-control-allow-origin']).toBe('https://skills.example.com');
    }
  } finally {
    await external.destroy();
  }
});
