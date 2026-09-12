import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';

const METHOD_SURFACE: ReadonlyArray<{ path: string; unsupported: string; allow: string }> = [
  { path: '/api/folder-config', unsupported: 'DELETE', allow: 'GET, PUT' },
  { path: '/api/template', unsupported: 'PATCH', allow: 'GET, PUT, POST, DELETE' },
  { path: '/api/template/import', unsupported: 'GET', allow: 'POST' },
];

const ALL_ROUTES = METHOD_SURFACE.map(({ path }) => path);

let tmpRoot: string;
let contentDir: string;
let server: BootedServer;

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-folder-template-native-'));
  contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nBody.\n', 'utf-8');
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('folder-template group over the composed listener — served natively', () => {
  test('every path is registered natively with verb gating (405 + Allow)', async () => {
    for (const { path, unsupported, allow } of METHOD_SURFACE) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: unsupported });
      expect(res.status, path).toBe(405);
      expect(res.headers.get('allow'), path).toBe(allow);
    }
  });

  test('GET /api/folder-config serves the project root folder meta natively', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/folder-config?path=`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('x-request-id')).not.toBeNull();
    const body = (await res.json()) as { folder?: unknown };
    expect(body.folder).toBeDefined();
  });

  test('folder-config rejects an escaping path with its own 400 (dispatch reaches the handler)', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/folder-config?path=${encodeURIComponent('../escape')}`,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-request');
  });

  test('GET /api/template walks leaf → root and 404s an absent template', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/template?name=absent&folder=`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:template-not-found');
  });

  test('template name validation survives the lift (bad name → 400)', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/template?name=${encodeURIComponent('bad.name')}&folder=`,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-request');
  });

  test('PUT /api/template refuses a folder that symlinks out of the content root', async () => {
    const outside = await mkdtemp(resolve(tmpRoot, 'tpl-outside-'));
    symlinkSync(outside, resolve(contentDir, 'tpl-escape'), 'dir');
    const res = await fetch(`http://127.0.0.1:${server.port}/api/template`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder: 'tpl-escape/sub',
        name: 'planted',
        body: 'body',
        frontmatter: { title: 'Planted' },
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:path-escape');
    expect(existsSync(resolve(outside, 'sub', '.ok', 'templates', 'planted.md'))).toBe(false);
  });

  test('PUT /api/template refuses a real .ok whose templates dir symlinks out', async () => {
    const outside = await mkdtemp(resolve(tmpRoot, 'tpl-outside-deep-'));
    mkdirSync(resolve(contentDir, 'tpl-real', '.ok'), { recursive: true });
    symlinkSync(outside, resolve(contentDir, 'tpl-real', '.ok', 'templates'), 'dir');
    const res = await fetch(`http://127.0.0.1:${server.port}/api/template`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder: 'tpl-real',
        name: 'planted',
        body: 'body',
        frontmatter: { title: 'Planted' },
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:symlink-refused');
    expect(existsSync(resolve(outside, 'planted.md'))).toBe(false);
  });

  test('PUT /api/template refuses an IN-ROOT symlinked templates dir and writes nothing through it', async () => {
    mkdirSync(resolve(contentDir, 'inroot-target'), { recursive: true });
    mkdirSync(resolve(contentDir, 'tpl-inroot', '.ok'), { recursive: true });
    symlinkSync(
      '../../inroot-target',
      resolve(contentDir, 'tpl-inroot', '.ok', 'templates'),
      'dir',
    );
    const res = await fetch(`http://127.0.0.1:${server.port}/api/template`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder: 'tpl-inroot',
        name: 'planted',
        body: 'body',
        frontmatter: { title: 'Planted' },
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:symlink-refused');
    expect(existsSync(resolve(contentDir, 'inroot-target', 'planted.md'))).toBe(false);
  });

  test('PUT /api/template refuses an IN-ROOT symlinked template LEAF and leaves the target intact', async () => {
    mkdirSync(resolve(contentDir, '.claude'), { recursive: true });
    writeFileSync(resolve(contentDir, '.claude', 'CLAUDE.md'), '# victim\n', 'utf-8');
    mkdirSync(resolve(contentDir, 'tpl-leaf', '.ok', 'templates'), { recursive: true });
    const leaf = resolve(contentDir, 'tpl-leaf', '.ok', 'templates', 'meeting.md');
    symlinkSync('../../../.claude/CLAUDE.md', leaf);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/template`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder: 'tpl-leaf',
        name: 'meeting',
        body: '# overwritten body',
        frontmatter: { title: 'Meeting' },
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:symlink-refused');
    expect(lstatSync(leaf).isSymbolicLink()).toBe(true);
    expect(readFileSync(resolve(contentDir, '.claude', 'CLAUDE.md'), 'utf-8')).toBe('# victim\n');
  });

  test('DELETE /api/template refuses an IN-ROOT symlinked templates dir and unlinks nothing through it', async () => {
    mkdirSync(resolve(contentDir, 'del-target'), { recursive: true });
    const victim = resolve(contentDir, 'del-target', 'keep.md');
    writeFileSync(victim, '# keep me\n', 'utf-8');
    mkdirSync(resolve(contentDir, 'tpl-del', '.ok'), { recursive: true });
    symlinkSync('../../del-target', resolve(contentDir, 'tpl-del', '.ok', 'templates'), 'dir');
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/template?folder=tpl-del&name=keep`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:symlink-refused');
    expect(readFileSync(victim, 'utf-8')).toBe('# keep me\n');
  });

  test('POST /api/template/import refuses an IN-ROOT symlinked template LEAF and leaves the link and its target intact', async () => {
    mkdirSync(resolve(contentDir, '.agents'), { recursive: true });
    const victim = resolve(contentDir, '.agents', 'AGENTS.md');
    writeFileSync(victim, '# victim agent definition\n', 'utf-8');
    mkdirSync(resolve(contentDir, 'tpl-import', '.ok', 'templates'), { recursive: true });
    const leaf = resolve(contentDir, 'tpl-import', '.ok', 'templates', 'alpha.md');
    symlinkSync('../../../.agents/AGENTS.md', leaf);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/template/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath: 'alpha', targetFolder: 'tpl-import', name: 'alpha' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:symlink-refused');
    expect(lstatSync(leaf).isSymbolicLink()).toBe(true);
    expect(readFileSync(victim, 'utf-8')).toBe('# victim agent definition\n');
  });

  test.runIf(process.getuid?.() !== 0)(
    'POST /api/template (move) surfaces an uninspectable ANCESTOR .ok/templates as 500, not 404',
    async () => {
      const ancestorOk = resolve(contentDir, 'mv-root', '.ok');
      mkdirSync(ancestorOk, { recursive: true });
      mkdirSync(resolve(contentDir, 'mv-root', 'child'), { recursive: true });
      chmodSync(ancestorOk, 0o000);
      try {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/template`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fromFolder: 'mv-root/child',
            fromName: 'ghost',
            toFolder: 'mv-root/child',
            toName: 'ghost-renamed',
          }),
        });
        expect(res.status).toBe(500);
        const body = (await res.json()) as { type?: string; detail?: string };
        expect(body.type).toBe('urn:ok:error:internal-server-error');
        expect(body.detail).toBe('EACCES');
      } finally {
        chmodSync(ancestorOk, 0o755);
      }
    },
  );

  test('template/import refuses a schema-invalid body with 400 before any doc read', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/template/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-request');
  });

  test('all three paths refuse a rebound Host before the verb check (403, no Allow leak)', async () => {
    for (const path of ALL_ROUTES) {
      const res = await rawRequest(server.port, path, { headers: { Host: 'evil.example' } });
      expect(res.status, path).toBe(403);
      expect(res.headers.allow, path).toBeUndefined();
      expect(parseProblem(res.body).type, path).toBe('urn:ok:error:host-not-allowed');
    }
  });

  test('foreign Origin is refused before dispatch on a ported route', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/folder-config?path=`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-origin');
  });

  test('sibling native groups still answer on the same server (multi-group dispatch)', async () => {
    const linkGraph = await fetch(`http://127.0.0.1:${server.port}/api/backlinks?docName=alpha`);
    expect(linkGraph.status).toBe(200);
    const packs = await fetch(`http://127.0.0.1:${server.port}/api/seed/packs`);
    expect(packs.status).toBe(200);
  });
});
