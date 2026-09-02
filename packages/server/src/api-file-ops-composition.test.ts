import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig, parseProblem, rawRequest } from './composition-rig.test-helper.ts';
import { tmpUploadDir } from './upload-streaming.ts';

const FAMILY_PATHS = [
  '/api/create-page',
  '/api/create-folder',
  '/api/duplicate-path',
  '/api/rename-path',
  '/api/delete-path',
  '/api/trash/cleanup',
  '/api/upload',
];

let tmpRoot: string;
let contentDir: string;
let server: BootedServer;

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function uploadForm(fields: Record<string, string>, file?: { name: string; bytes: string }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append('file', new Blob([file.bytes]), file.name);
  return form;
}

beforeAll(async () => {
  tmpRoot = await mkdtemp(resolve(tmpdir(), 'ok-file-ops-native-'));
  contentDir = mkdtempSync(resolve(tmpRoot, 'content-'));
  writeFileSync(resolve(contentDir, 'alpha.md'), '# Alpha\n\nBody.\n', 'utf-8');
  server = await bootCompositionRig(contentDir);
  await server.ready;
}, 60_000);

afterAll(async () => {
  await server?.destroy();
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('file-ops group over the composed listener — served natively', () => {
  test('every path is registered natively with verb gating (405 + Allow: POST)', async () => {
    for (const path of FAMILY_PATHS) {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
      expect(res.status, path).toBe(405);
      expect(res.headers.get('allow'), path).toBe('POST');
    }
  });

  test('create-page serves natively and returns the created docName', async () => {
    const res = await postJson('/api/create-page', { path: 'notes/created-native.md' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).not.toBeNull();
    expect(((await res.json()) as { docName?: string }).docName).toBe('notes/created-native');
  });

  test('create-page path validation still lands as typed problems', async () => {
    const noExt = await postJson('/api/create-page', { path: 'not-a-doc.txt' });
    expect(noExt.status).toBe(400);
    expect(((await noExt.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-request');

    const escaped = await postJson('/api/create-page', { path: '../outside.md' });
    expect(escaped.status).toBe(400);
    expect(((await escaped.json()) as { type?: string }).type).toBe('urn:ok:error:path-escape');
  });

  test('create-page rejects non-canonical `.`/empty segments (intentional tightening)', async () => {
    for (const path of ['./notes/x.md', 'notes//x.md']) {
      const res = await postJson('/api/create-page', { path });
      expect(res.status, path).toBe(400);
      expect(((await res.json()) as { type?: string }).type, path).toBe('urn:ok:error:path-escape');
    }
  });

  test('create-page refuses a path routed through a symlinked directory escaping the content root', async () => {
    const outside = mkdtempSync(resolve(tmpRoot, 'outside-'));
    symlinkSync(outside, resolve(contentDir, 'sneaky'), 'dir');
    const res = await postJson('/api/create-page', { path: 'sneaky/escaped.md' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:path-escape');
    expect(existsSync(resolve(outside, 'escaped.md'))).toBe(false);
  });

  test('create-page drops a template symlinked outside the content root from the menu', async () => {
    const secretDir = mkdtempSync(resolve(tmpRoot, 'secret-'));
    writeFileSync(resolve(secretDir, 'secret.txt'), 'TOP SECRET', 'utf-8');
    const tplDir = resolve(contentDir, 'leaky', '.ok', 'templates');
    mkdirSync(tplDir, { recursive: true });
    symlinkSync(resolve(secretDir, 'secret.txt'), resolve(tplDir, 'leak.md'), 'file');
    const res = await postJson('/api/create-page', {
      path: 'leaky/from-leak.md',
      template: 'leak',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-request');
    expect(existsSync(resolve(contentDir, 'leaky', 'from-leak.md'))).toBe(false);
  });

  test('create-page refuses a target routed into .ok through a symlinked directory', async () => {
    symlinkSync(resolve(contentDir, '.ok'), resolve(contentDir, 'escape-hatch'), 'dir');
    const res = await postJson('/api/create-page', {
      path: 'escape-hatch/skills/phantom.md',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:reserved-doc-name');
    expect(existsSync(resolve(contentDir, '.ok', 'skills', 'phantom.md'))).toBe(false);
  });

  test('delete-path refuses a recursive delete routed into .ok through a symlink', async () => {
    mkdirSync(resolve(contentDir, '.ok', 'local'), { recursive: true });
    writeFileSync(resolve(contentDir, '.ok', 'local', 'survivor-marker'), 'still here', 'utf-8');
    symlinkSync(resolve(contentDir, '.ok'), resolve(contentDir, 'esc-del'), 'dir');
    const res = await postJson('/api/delete-path', { kind: 'folder', path: 'esc-del/local' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:reserved-doc-name');
    expect(existsSync(resolve(contentDir, '.ok', 'local', 'survivor-marker'))).toBe(true);
  });

  test('rename-path refuses a destination routed into .ok/skills through a symlink', async () => {
    symlinkSync(resolve(contentDir, '.ok'), resolve(contentDir, 'esc-ren'), 'dir');
    const res = await postJson('/api/rename-path', {
      kind: 'file',
      fromPath: 'alpha',
      toPath: 'esc-ren/skills/evil',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:reserved-doc-name');
    expect(existsSync(resolve(contentDir, '.ok', 'skills', 'evil.md'))).toBe(false);
  });

  test('rename-path refuses a SOURCE routed into .ok through a symlink', async () => {
    mkdirSync(resolve(contentDir, '.ok', 'local'), { recursive: true });
    symlinkSync(resolve(contentDir, '.ok'), resolve(contentDir, 'esc-ren-src'), 'dir');
    const res = await postJson('/api/rename-path', {
      kind: 'folder',
      fromPath: 'esc-ren-src/local',
      toPath: 'stolen',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:reserved-doc-name');
    expect(existsSync(resolve(contentDir, '.ok', 'local'))).toBe(true);
    expect(existsSync(resolve(contentDir, 'stolen'))).toBe(false);
  });

  test('create-folder refuses a directory routed into .ok through a symlink', async () => {
    symlinkSync(resolve(contentDir, '.ok'), resolve(contentDir, 'esc-cf'), 'dir');
    const res = await postJson('/api/create-folder', { path: 'esc-cf/skills' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:reserved-doc-name');
  });

  test('duplicate-path refuses a source routed into .ok through a symlink', async () => {
    symlinkSync(resolve(contentDir, '.ok'), resolve(contentDir, 'esc-dup'), 'dir');
    const res = await postJson('/api/duplicate-path', { kind: 'folder', path: 'esc-dup/local' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:reserved-doc-name');
  });

  test('upload refuses a parentDocName inside .ok, no symlink needed', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/upload`, {
      method: 'POST',
      body: uploadForm(
        { parentDocName: '.ok/skills/planted' },
        { name: 'evil.md', bytes: 'planted skill content' },
      ),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:reserved-doc-name');
    expect(existsSync(resolve(contentDir, '.ok', 'skills', 'evil.md'))).toBe(false);
  });

  test('upload refuses a parentDocName routed into .ok through a symlink', async () => {
    symlinkSync(resolve(contentDir, '.ok'), resolve(contentDir, 'esc-upload'), 'dir');
    const res = await fetch(`http://127.0.0.1:${server.port}/api/upload`, {
      method: 'POST',
      body: uploadForm(
        { parentDocName: 'esc-upload/skills/planted' },
        { name: 'sneaky.md', bytes: 'planted skill content' },
      ),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:reserved-doc-name');
    expect(existsSync(resolve(contentDir, '.ok', 'skills', 'sneaky.md'))).toBe(false);
  });

  test('upload refuses a ./-prefixed parentDocName with the same precondition as its siblings', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/upload`, {
      method: 'POST',
      body: uploadForm(
        { parentDocName: './dotted-esc/skills/planted' },
        { name: 'dotted.md', bytes: 'planted skill content' },
      ),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:path-escape');
    expect(existsSync(resolve(contentDir, 'dotted-esc'))).toBe(false);
  });

  test('upload accepts a parentDocName whose basename carries a backslash', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/upload`, {
      method: 'POST',
      body: uploadForm(
        { parentDocName: 'alpha/notes\\draft.png' },
        { name: 'dropped.png', bytes: 'png-ish bytes' },
      ),
    });
    expect(res.status).toBe(200);
  });

  test('create-folder maps a symlink escape OUT of the content root to a 400, not a 500', async () => {
    const outsideTarget = mkdtempSync(resolve(tmpRoot, 'escape-out-'));
    symlinkSync(outsideTarget, resolve(contentDir, 'escape-out'), 'dir');
    const res = await postJson('/api/create-folder', { path: 'escape-out/foo' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:path-escape');
  });

  test('duplicate-path maps a symlink escape OUT of the content root to a 400, not a 500', async () => {
    const outsideTarget = mkdtempSync(resolve(tmpRoot, 'escape-dup-out-'));
    symlinkSync(outsideTarget, resolve(contentDir, 'escape-dup-out'), 'dir');
    const res = await postJson('/api/duplicate-path', {
      kind: 'folder',
      path: 'escape-dup-out/foo',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:path-escape');
  });

  test('create-folder creates and refuses reserved directories', async () => {
    const ok = await postJson('/api/create-folder', { path: 'made-native' });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { path?: string }).path).toBe('made-native');

    const reserved = await postJson('/api/create-folder', { path: '.ok/nested' });
    expect(reserved.status).toBe(400);
    expect(((await reserved.json()) as { type?: string }).type).toBe(
      'urn:ok:error:reserved-doc-name',
    );
  });

  test('duplicate-path duplicates a document through the lifted route', async () => {
    const res = await postJson('/api/duplicate-path', { kind: 'file', path: 'alpha.md' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { duplicatedDocNames?: string[] };
    expect(body.duplicatedDocNames).toHaveLength(1);
  });

  test('rename-path no-op (fromPath === toPath) short-circuits to the empty success shape', async () => {
    const res = await postJson('/api/rename-path', {
      kind: 'file',
      fromPath: 'alpha',
      toPath: 'alpha',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ renamed: [], renamedAssets: [], rewrittenDocs: [] });
  });

  test('rename-path refuses reserved directories with the typed problem', async () => {
    const res = await postJson('/api/rename-path', {
      kind: 'file',
      fromPath: 'alpha',
      toPath: '.ok/alpha',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:reserved-doc-name');
  });

  test('delete-path 404s a missing target and deletes a real one', async () => {
    const missing = await postJson('/api/delete-path', { kind: 'file', path: 'no-such-doc' });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { type?: string }).type).toBe('urn:ok:error:doc-not-found');

    const seed = await postJson('/api/create-page', { path: 'doomed-native.md' });
    expect(seed.status).toBe(200);
    const res = await postJson('/api/delete-path', { kind: 'file', path: 'doomed-native' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deletedDocNames?: string[] }).deletedDocNames).toContain(
      'doomed-native',
    );
  });

  test('trash-cleanup is idempotent for an already-gone file and refuses synthetic names', async () => {
    const gone = await postJson('/api/trash/cleanup', { kind: 'file', path: 'never-existed.md' });
    expect(gone.status).toBe(200);
    expect(((await gone.json()) as { deletedDocNames?: string[] }).deletedDocNames).toEqual([]);

    const reserved = await postJson('/api/trash/cleanup', {
      kind: 'folder',
      path: '__system__',
    });
    expect(reserved.status).toBe(400);
    expect(((await reserved.json()) as { type?: string }).type).toBe(
      'urn:ok:error:reserved-doc-name',
    );
  });

  test('upload stores a multipart file', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/upload`, {
      method: 'POST',
      body: uploadForm({ parentDocName: 'alpha' }, { name: 'pic.png', bytes: 'pic-bytes-1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { src?: string; path?: string; deduped?: boolean };
    expect(typeof body.src).toBe('string');
    expect(typeof body.path).toBe('string');
    expect(body.deduped).toBe(false);
  });

  test('fields-only multipart (no file part) lands as 400 no-file-received, not a hang', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/upload`, {
      method: 'POST',
      body: uploadForm({ parentDocName: 'alpha' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:no-file-received');
  });

  test('a multipart content-type without a boundary is a 400 malformed-upload', async () => {
    const res = await rawRequest(server.port, '/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data' },
      body: 'not a multipart body',
    });
    expect(res.status).toBe(400);
    expect(parseProblem(res.body).type).toBe('urn:ok:error:malformed-upload');
  });

  test('a client that disconnects mid-multipart does not wedge the server (req.complete guard)', async () => {
    const stagingDir = tmpUploadDir(contentDir);
    const stagedUploads = () =>
      existsSync(stagingDir)
        ? readdirSync(stagingDir).filter((name) => name.startsWith('upload-'))
        : [];
    const waitFor = async (what: string, predicate: () => boolean): Promise<void> => {
      const deadline = Date.now() + 4_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const boundary = 'x-ok-test-boundary';
    for (let i = 0; i < 3; i++) {
      await new Promise<void>((resolveAbort, rejectAbort) => {
        const sock = connect(server.port, '127.0.0.1', () => {
          const partial = [
            `POST /api/upload HTTP/1.1`,
            `Host: 127.0.0.1:${server.port}`,
            `Content-Type: multipart/form-data; boundary=${boundary}`,
            `Content-Length: 100000`,
            '',
            `--${boundary}`,
            `Content-Disposition: form-data; name="file"; filename="cut.bin"`,
            `Content-Type: application/octet-stream`,
            '',
            'partial-bytes-then-gone',
          ].join('\r\n');
          sock.write(partial);
          waitFor('a staged tempfile', () => stagedUploads().length > 0).then(() => {
            sock.destroy();
            resolveAbort();
          }, rejectAbort);
        });
        sock.on('error', () => {});
      });
      await waitFor('the staging dir to drain', () => stagedUploads().length === 0);
    }
    const after = await fetch(`http://127.0.0.1:${server.port}/api/upload`, {
      method: 'POST',
      body: uploadForm(
        { parentDocName: 'alpha' },
        { name: 'after-aborts.png', bytes: 'after-abort-bytes' },
      ),
    });
    expect(after.status).toBe(200);
  }, 45_000);

  test('an oversized JSON body on an ordinary family route is a clean 413', async () => {
    const res = await rawRequest(server.port, '/api/create-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'big.md', pad: 'x'.repeat(1_100_000) }),
    });
    expect(res.status).toBe(413);
    expect(parseProblem(res.body).type).toBe('urn:ok:error:payload-too-large');
  });

  test('the whole family refuses a rebound Host on its GET arms too (admission unchanged)', async () => {
    for (const path of FAMILY_PATHS) {
      const res = await rawRequest(server.port, path, {
        headers: { Host: 'evil.example' },
      });
      expect(res.status, path).toBe(403);
      expect(parseProblem(res.body).type, path).toBe('urn:ok:error:host-not-allowed');
      expect(res.headers.allow, path).toBeUndefined();
    }
  });

  test('foreign Origin is refused before dispatch on a ported route', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/upload`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      body: uploadForm(
        { parentDocName: 'alpha' },
        { name: 'x.png', bytes: 'origin-refused-bytes' },
      ),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { type?: string }).type).toBe('urn:ok:error:invalid-origin');
  });

  test('any forwarding header trips the proxied-request refusal on a ported route', async () => {
    const res = await rawRequest(server.port, '/api/delete-path', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': '203.0.113.7',
      },
      body: JSON.stringify({ kind: 'file', path: 'alpha' }),
    });
    expect(res.status).toBe(403);
    const body = parseProblem(res.body);
    expect(body.type).toBe('urn:ok:error:host-not-allowed');
    expect(body.detail ?? body.title).toContain('Proxied request refused');
  });

  test('OPTIONS preflight answers 204 on a ported route', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/upload`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, PUT, DELETE, OPTIONS');
  });

  test('both chained groups answer on one server (multi-group dispatch)', async () => {
    const linkGraph = await fetch(`http://127.0.0.1:${server.port}/api/backlinks?docName=alpha`);
    expect(linkGraph.status).toBe(200);
    const created = await postJson('/api/create-page', { path: 'chained-dispatch.md' });
    expect(created.status).toBe(200);
  });
});
