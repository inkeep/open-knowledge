import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createApiExtension } from './api-extension.test-helper.ts';

/**
 * Characterization for GET/PUT /api/folder-config ahead of the files/folders
 * extraction — neither method had any server-unit coverage. Pins the wire
 * contract: GET's self-only `frontmatter_local` (no ancestor cascade, null
 * when absent, {} when the YAML is a non-object, null again when malformed),
 * PUT's merge-patch outcomes (written/deleted/noop) landing in
 * `<folder>/.ok/frontmatter.yml`, the project-root-relative path gate, and
 * the single-file-mode refusal.
 */

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function makeReq(url: string, method: string, body?: unknown): IncomingMessage {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const readable = Readable.from(Buffer.from(raw)) as unknown as IncomingMessage;
  readable.method = method;
  readable.url = url;
  readable.headers = { host: 'localhost' };
  return readable;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: '' };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      if (headers) Object.assign(captured.headers, headers);
    },
    end(body?: string) {
      captured.body = body ?? '';
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

describe('GET/PUT /api/folder-config', () => {
  let tmpDir: string;
  let contentDir: string;

  function buildExt(extra?: { ephemeral?: boolean }) {
    return createApiExtension({
      hocuspocus: {} as Parameters<typeof createApiExtension>[0]['hocuspocus'],
      sessionManager: {} as Parameters<typeof createApiExtension>[0]['sessionManager'],
      contentDir,
      serverInstanceId: 'test-server',
      getFileIndex: () => new Map(),
      ...extra,
    }) as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    };
  }

  async function dispatch(
    ext: ReturnType<typeof buildExt>,
    url: string,
    method: string,
    body?: unknown,
  ): Promise<CapturedResponse> {
    const { res, captured } = makeRes();
    await ext.onRequest({ request: makeReq(url, method, body), response: res });
    return captured;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-folder-config-'));
    contentDir = join(tmpDir, 'content');
    mkdirSync(join(contentDir, 'docs', '.ok'), { recursive: true });
    mkdirSync(join(contentDir, 'plain'), { recursive: true });
    mkdirSync(join(contentDir, 'weird', '.ok'), { recursive: true });
    mkdirSync(join(contentDir, 'broken', '.ok'), { recursive: true });
    writeFileSync(
      join(contentDir, 'docs', '.ok', 'frontmatter.yml'),
      'status: active\nowner: omar\n',
    );
    writeFileSync(join(contentDir, 'weird', '.ok', 'frontmatter.yml'), '- just\n- a list\n');
    writeFileSync(join(contentDir, 'broken', '.ok', 'frontmatter.yml'), 'key: [unclosed\n');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('GET returns the folder meta plus self-only frontmatter_local', async () => {
    const ext = buildExt();
    const captured = await dispatch(ext, '/api/folder-config?path=docs', 'GET');
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body) as {
      folder: Record<string, unknown>;
      frontmatter_local: Record<string, unknown> | null;
    };
    expect(typeof body.folder).toBe('object');
    expect(body.frontmatter_local).toEqual({ status: 'active', owner: 'omar' });
  });

  test('GET reports null frontmatter_local when the sidecar is absent', async () => {
    const ext = buildExt();
    const captured = await dispatch(ext, '/api/folder-config?path=plain', 'GET');
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body).frontmatter_local).toBeNull();
  });

  test('GET does not cascade an ancestor sidecar onto a sidecar-less child', async () => {
    // Pins the SELF-ONLY contract against a fixture where a cascade would be
    // observable: `docs/.ok/frontmatter.yml` exists, `docs/sub` has no
    // sidecar of its own. An accidental reuse of the template-resolution
    // ancestor walk would surface the parent's map here instead of null.
    mkdirSync(join(contentDir, 'docs', 'sub'), { recursive: true });
    const ext = buildExt();
    const captured = await dispatch(
      ext,
      `/api/folder-config?path=${encodeURIComponent('docs/sub')}`,
      'GET',
    );
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body).frontmatter_local).toBeNull();
  });

  test('GET flattens a non-object YAML document to {} and malformed YAML to null', async () => {
    const ext = buildExt();
    const list = await dispatch(ext, '/api/folder-config?path=weird', 'GET');
    expect(JSON.parse(list.body).frontmatter_local).toEqual({});

    const broken = await dispatch(ext, '/api/folder-config?path=broken', 'GET');
    expect(broken.status).toBe(200);
    expect(JSON.parse(broken.body).frontmatter_local).toBeNull();
  });

  test('GET rejects traversal and absolute paths as not project-root-relative', async () => {
    const ext = buildExt();
    const traversal = await dispatch(
      ext,
      `/api/folder-config?path=${encodeURIComponent('docs/../../outside')}`,
      'GET',
    );
    expect(traversal.status).toBe(400);
    expect(JSON.parse(traversal.body).type).toBe('urn:ok:error:invalid-request');

    const absolute = await dispatch(
      ext,
      `/api/folder-config?path=${encodeURIComponent('/etc')}`,
      'GET',
    );
    expect(absolute.status).toBe(400);
  });

  test('PUT writes the sidecar and reports written, then noop on an identical patch', async () => {
    const ext = buildExt();
    const first = await dispatch(ext, '/api/folder-config', 'PUT', {
      path: 'plain',
      frontmatter: { status: 'draft' },
    });
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body).applied).toEqual([
      { path: 'plain/.ok/frontmatter.yml', action: 'written' },
    ]);
    const sidecar = join(contentDir, 'plain', '.ok', 'frontmatter.yml');
    expect(existsSync(sidecar)).toBe(true);
    expect(await readFile(sidecar, 'utf-8')).toContain('status: draft');

    // No diff detection: an identical re-patch (and even a delete of a
    // nonexistent key on an existing sidecar) rewrites and reports
    // 'written' again. 'noop' fires only when there is nothing to do at
    // all: a null-only patch against a folder with no sidecar.
    const second = await dispatch(ext, '/api/folder-config', 'PUT', {
      path: 'plain',
      frontmatter: { status: 'draft' },
    });
    expect(JSON.parse(second.body).applied).toEqual([
      { path: 'plain/.ok/frontmatter.yml', action: 'written' },
    ]);

    mkdirSync(join(contentDir, 'untouched'), { recursive: true });
    const noop = await dispatch(ext, '/api/folder-config', 'PUT', {
      path: 'untouched',
      frontmatter: { 'never-existed': null },
    });
    expect(JSON.parse(noop.body).applied).toEqual([
      { path: 'untouched/.ok/frontmatter.yml', action: 'noop' },
    ]);
    expect(existsSync(join(contentDir, 'untouched', '.ok'))).toBe(false);
  });

  test('PUT with null values deletes keys; clearing the last key deletes the sidecar', async () => {
    const ext = buildExt();
    const cleared = await dispatch(ext, '/api/folder-config', 'PUT', {
      path: 'docs',
      frontmatter: { status: null, owner: null },
    });
    expect(cleared.status).toBe(200);
    expect(JSON.parse(cleared.body).applied).toEqual([
      { path: 'docs/.ok/frontmatter.yml', action: 'deleted' },
    ]);
    expect(existsSync(join(contentDir, 'docs', '.ok', 'frontmatter.yml'))).toBe(false);
  });

  test('PUT without a frontmatter field applies nothing', async () => {
    const ext = buildExt();
    const captured = await dispatch(ext, '/api/folder-config', 'PUT', { path: 'plain' });
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body).applied).toEqual([]);
  });

  test('PUT refuses in single-file mode with the dedicated URN', async () => {
    const ext = buildExt({ ephemeral: true });
    const captured = await dispatch(ext, '/api/folder-config', 'PUT', {
      path: 'plain',
      frontmatter: { a: 1 },
    });
    expect(captured.status).toBe(403);
    expect(JSON.parse(captured.body).type).toBe('urn:ok:error:single-file-mode');
  });

  test('PUT rejects a non-string summary before writing anything', async () => {
    const ext = buildExt();
    const captured = await dispatch(ext, '/api/folder-config', 'PUT', {
      path: 'plain',
      frontmatter: { a: 1 },
      summary: 42,
    });
    expect(captured.status).toBe(400);
    expect(existsSync(join(contentDir, 'plain', '.ok', 'frontmatter.yml'))).toBe(false);
  });
});
