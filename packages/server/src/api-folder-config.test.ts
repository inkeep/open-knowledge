import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createApiExtension } from './api-extension.test-helper.ts';

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
    expect(body).not.toHaveProperty('warningCodes');
    expect(body).not.toHaveProperty('warnings');
  });

  test('GET reports null frontmatter_local when the sidecar is absent', async () => {
    const ext = buildExt();
    const captured = await dispatch(ext, '/api/folder-config?path=plain', 'GET');
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body).frontmatter_local).toBeNull();
  });

  test('GET does not cascade an ancestor sidecar onto a sidecar-less child', async () => {
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
    const brokenBody = JSON.parse(broken.body) as {
      frontmatter_local: Record<string, unknown> | null;
      warningCodes?: string[];
    };
    expect(brokenBody.frontmatter_local).toBeNull();
    expect(brokenBody.warningCodes).toEqual(['malformed-yaml']);
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

  test('GET degrades a symlinked frontmatter.yml leaf: null field + signal, no leak, folder meta intact', async () => {
    const secret = join(tmpDir, 'gh-hosts.yml');
    writeFileSync(secret, 'oauth_token: leak-me-not\n');
    mkdirSync(join(contentDir, 'linked', '.ok'), { recursive: true });
    symlinkSync(secret, join(contentDir, 'linked', '.ok', 'frontmatter.yml'));
    const ext = buildExt();
    const captured = await dispatch(ext, '/api/folder-config?path=linked', 'GET');
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body) as {
      folder: Record<string, unknown>;
      frontmatter_local: Record<string, unknown> | null;
      warningCodes?: string[];
    };
    expect(body.frontmatter_local).toBeNull();
    expect(body.warningCodes).toEqual(['symlink-refused']);
    expect(typeof body.folder).toBe('object');
    expect(captured.body).not.toContain('leak-me-not');
  });

  test('GET degrades a symlinked frontmatter.yml leaf even when the target stays in-root', async () => {
    mkdirSync(join(contentDir, '.git'), { recursive: true });
    writeFileSync(join(contentDir, '.git', 'config'), 'password: in-root-secret\n');
    mkdirSync(join(contentDir, 'inroot', '.ok'), { recursive: true });
    symlinkSync('../../.git/config', join(contentDir, 'inroot', '.ok', 'frontmatter.yml'));
    const ext = buildExt();
    const captured = await dispatch(ext, '/api/folder-config?path=inroot', 'GET');
    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body) as {
      frontmatter_local: Record<string, unknown> | null;
      warningCodes?: string[];
    };
    expect(body.frontmatter_local).toBeNull();
    expect(body.warningCodes).toEqual(['symlink-refused']);
    expect(captured.body).not.toContain('in-root-secret');
  });

  test('GET refuses an in-root symlinked .ok directory outright (aliasing bypass)', async () => {
    mkdirSync(join(contentDir, 'secretdir'), { recursive: true });
    writeFileSync(join(contentDir, 'secretdir', 'frontmatter.yml'), 'hidden: aliased-secret\n');
    mkdirSync(join(contentDir, 'aliased'), { recursive: true });
    symlinkSync('../secretdir', join(contentDir, 'aliased', '.ok'), 'dir');
    const ext = buildExt();
    const captured = await dispatch(ext, '/api/folder-config?path=aliased', 'GET');
    expect(captured.status).toBe(400);
    expect(JSON.parse(captured.body).type).toBe('urn:ok:error:symlink-refused');
    expect(captured.body).not.toContain('aliased-secret');
  });

  test('PUT refuses a symlinked frontmatter.yml leaf and does not materialize it', async () => {
    const secret = join(tmpDir, 'kube-config.yml');
    writeFileSync(secret, 'token: hush\n');
    mkdirSync(join(contentDir, 'linkput', '.ok'), { recursive: true });
    const leaf = join(contentDir, 'linkput', '.ok', 'frontmatter.yml');
    symlinkSync(secret, leaf);
    const ext = buildExt();
    const captured = await dispatch(ext, '/api/folder-config', 'PUT', {
      path: 'linkput',
      frontmatter: { status: 'draft' },
    });
    expect(captured.status).toBe(400);
    expect(JSON.parse(captured.body).type).toBe('urn:ok:error:symlink-refused');
    expect(lstatSync(leaf).isSymbolicLink()).toBe(true);
    expect(readFileSync(secret, 'utf-8')).toBe('token: hush\n');
  });

  test('PUT refuses an in-root symlinked leaf (leaf identity, not containment)', async () => {
    mkdirSync(join(contentDir, '.git'), { recursive: true });
    writeFileSync(join(contentDir, '.git', 'config'), 'password: put-in-root\n');
    mkdirSync(join(contentDir, 'inrootput', '.ok'), { recursive: true });
    const leaf = join(contentDir, 'inrootput', '.ok', 'frontmatter.yml');
    symlinkSync('../../.git/config', leaf);
    const ext = buildExt();
    const captured = await dispatch(ext, '/api/folder-config', 'PUT', {
      path: 'inrootput',
      frontmatter: { status: 'draft' },
    });
    expect(captured.status).toBe(400);
    expect(JSON.parse(captured.body).type).toBe('urn:ok:error:symlink-refused');
    expect(lstatSync(leaf).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(contentDir, '.git', 'config'), 'utf-8')).toBe(
      'password: put-in-root\n',
    );
  });

  test('GET degrades a requested folder whose .ok/templates symlinks OUT of the content root (same as in-root)', async () => {
    const outside = join(tmpDir, 'outside-tpl');
    mkdirSync(outside);
    writeFileSync(join(outside, 'leak.md'), '---\ntitle: Leak\n---\n');
    mkdirSync(join(contentDir, 'esc', '.ok'), { recursive: true });
    symlinkSync(outside, join(contentDir, 'esc', '.ok', 'templates'), 'dir');
    const get = await dispatch(buildExt(), '/api/folder-config?path=esc', 'GET');
    expect(get.status).toBe(200);
    const body = JSON.parse(get.body) as {
      folder: { templates_available?: Array<{ name: string }> };
      warningCodes?: string[];
    };
    expect(body.folder.templates_available ?? []).toEqual([]);
    expect(body.warningCodes).toEqual(['templates-symlink-refused']);
    expect(get.body).not.toContain('leak');
  });

  test('GET no longer 500s when the requested folder has a regular FILE named .ok', async () => {
    mkdirSync(join(contentDir, 'flatok'), { recursive: true });
    writeFileSync(join(contentDir, 'flatok', '.ok'), 'not a directory\n');
    const get = await dispatch(buildExt(), '/api/folder-config?path=flatok', 'GET');
    expect(get.status).toBe(200);
    expect(JSON.parse(get.body).warningCodes).toEqual(['unverifiable']);
  });

  test.runIf(process.getuid?.() !== 0)(
    'GET degrades an uninspectable OWN .ok (EACCES) instead of 500ing, templates from the root still resolve',
    async () => {
      const ownOk = join(contentDir, 'unvown', '.ok');
      mkdirSync(join(ownOk, 'templates'), { recursive: true });
      mkdirSync(join(contentDir, '.ok', 'templates'), { recursive: true });
      writeFileSync(join(contentDir, '.ok', 'templates', 'global.md'), '---\ntitle: Global\n---\n');
      chmodSync(ownOk, 0o000);
      try {
        const get = await dispatch(buildExt(), '/api/folder-config?path=unvown', 'GET');
        expect(get.status).toBe(200);
        const body = JSON.parse(get.body) as {
          folder: { templates_available?: Array<{ name: string }> };
          warningCodes?: string[];
        };
        expect((body.folder.templates_available ?? []).map((t) => t.name)).toEqual(['global']);
        expect(body.warningCodes).toEqual(['templates-unverifiable', 'unverifiable']);
      } finally {
        chmodSync(ownOk, 0o755);
      }
    },
  );

  test('GET degrades a DANGLING .ok/templates link (what a clone of a committed link produces)', async () => {
    mkdirSync(join(contentDir, 'dangle', '.ok'), { recursive: true });
    symlinkSync(
      '/nonexistent/attacker/templates',
      join(contentDir, 'dangle', '.ok', 'templates'),
      'dir',
    );
    const get = await dispatch(buildExt(), '/api/folder-config?path=dangle', 'GET');
    expect(get.status).toBe(200);
    const body = JSON.parse(get.body) as { warningCodes?: string[]; warnings?: string[] };
    expect(body.warningCodes).toEqual(['templates-symlink-refused']);
    expect(body.warnings?.[0]).toContain('dangle/.ok/templates is a symlink');
  });

  test('an in-root symlinked .ok/templates refuses the template arms but degrades folder-config', async () => {
    mkdirSync(join(contentDir, 'agentsdir'), { recursive: true });
    writeFileSync(join(contentDir, 'agentsdir', 'keep.md'), '# keep me\n');
    mkdirSync(join(contentDir, 'aliased3', '.ok'), { recursive: true });
    symlinkSync('../../agentsdir', join(contentDir, 'aliased3', '.ok', 'templates'), 'dir');
    mkdirSync(join(contentDir, '.ok', 'templates'), { recursive: true });
    writeFileSync(join(contentDir, '.ok', 'templates', 'global.md'), '---\ntitle: Global\n---\n');
    const ext = buildExt();

    const get = await dispatch(ext, '/api/folder-config?path=aliased3', 'GET');
    expect(get.status).toBe(200);
    const getBody = JSON.parse(get.body) as {
      folder: { templates_available?: Array<{ name: string }> };
      warnings?: string[];
      warningCodes?: string[];
    };
    expect((getBody.folder.templates_available ?? []).map((t) => t.name)).toEqual(['global']);
    expect(getBody.warningCodes).toEqual(['templates-symlink-refused']);
    expect(getBody.warnings).toEqual([
      'aliased3/.ok/templates is a symlink — its templates are not enumerated. Replace the symlink with a real file or directory and retry.',
    ]);
    expect(get.body).not.toContain('keep.md');

    const put = await dispatch(ext, '/api/template', 'PUT', {
      folder: 'aliased3',
      name: 'planted',
      body: '# planted\n',
      frontmatter: { title: 'Planted' },
    });
    expect(put.status).toBe(400);
    expect(JSON.parse(put.body).type).toBe('urn:ok:error:symlink-refused');

    const del = await dispatch(ext, `/api/template?folder=aliased3&name=keep`, 'DELETE');
    expect(del.status).toBe(400);
    expect(JSON.parse(del.body).type).toBe('urn:ok:error:symlink-refused');
  });

  test('GET reports a symlinked ANCESTOR .ok/templates the folder would inherit from', async () => {
    mkdirSync(join(contentDir, 'agentsdir-anc'), { recursive: true });
    writeFileSync(join(contentDir, 'agentsdir-anc', 'keep.md'), '# keep me\n');
    mkdirSync(join(contentDir, 'anc', '.ok'), { recursive: true });
    mkdirSync(join(contentDir, 'anc', 'child'), { recursive: true });
    symlinkSync('../../agentsdir-anc', join(contentDir, 'anc', '.ok', 'templates'), 'dir');
    const ext = buildExt();

    mkdirSync(join(contentDir, '.ok', 'templates'), { recursive: true });
    writeFileSync(join(contentDir, '.ok', 'templates', 'global.md'), '---\ntitle: Global\n---\n');

    const get = await dispatch(ext, '/api/folder-config?path=anc/child', 'GET');
    expect(get.status).toBe(200);
    const getBody = JSON.parse(get.body) as {
      folder: { templates_available?: Array<{ name: string }> };
      warnings?: string[];
      warningCodes?: string[];
    };
    expect((getBody.folder.templates_available ?? []).map((t) => t.name)).toEqual(['global']);
    expect(getBody.warningCodes).toEqual(['templates-symlink-refused']);
    expect(getBody.warnings?.[0]).toContain('anc/.ok/templates is a symlink');
    expect(get.body).not.toContain('keep.md');
  });

  test('GET reports a symlinked ANCESTOR .ok (menu skips it) while the requested folder still resolves', async () => {
    mkdirSync(join(contentDir, 'agentsdir-ancok', 'templates'), { recursive: true });
    writeFileSync(join(contentDir, 'agentsdir-ancok', 'templates', 'keep.md'), '# keep me\n');
    mkdirSync(join(contentDir, 'ancok', 'child'), { recursive: true });
    symlinkSync('../agentsdir-ancok', join(contentDir, 'ancok', '.ok'), 'dir');
    const ext = buildExt();

    mkdirSync(join(contentDir, '.ok', 'templates'), { recursive: true });
    writeFileSync(join(contentDir, '.ok', 'templates', 'global.md'), '---\ntitle: Global\n---\n');

    const get = await dispatch(ext, '/api/folder-config?path=ancok/child', 'GET');
    expect(get.status).toBe(200);
    const getBody = JSON.parse(get.body) as {
      folder: { templates_available?: Array<{ name: string }> };
      warnings?: string[];
      warningCodes?: string[];
    };
    expect((getBody.folder.templates_available ?? []).map((t) => t.name)).toEqual(['global']);
    expect(getBody.warningCodes).toEqual(['templates-symlink-refused']);
    expect(getBody.warnings?.[0]).toContain('ancok/.ok is a symlink');
    expect(get.body).not.toContain('keep.md');
  });

  test.runIf(process.getuid?.() !== 0)(
    'GET reports an ANCESTOR .ok/templates it cannot inspect as unverifiable, not as absent',
    async () => {
      const ancestorOk = join(contentDir, 'unv', '.ok');
      mkdirSync(join(ancestorOk, 'templates'), { recursive: true });
      mkdirSync(join(contentDir, 'unv', 'child'), { recursive: true });
      mkdirSync(join(contentDir, '.ok', 'templates'), { recursive: true });
      writeFileSync(join(contentDir, '.ok', 'templates', 'global.md'), '---\ntitle: Global\n---\n');
      chmodSync(ancestorOk, 0o000);
      try {
        const ext = buildExt();
        const get = await dispatch(ext, '/api/folder-config?path=unv/child', 'GET');
        expect(get.status).toBe(200);
        const getBody = JSON.parse(get.body) as {
          folder: { templates_available?: Array<{ name: string }> };
          warnings?: string[];
          warningCodes?: string[];
        };
        expect((getBody.folder.templates_available ?? []).map((t) => t.name)).toEqual(['global']);
        expect(getBody.warningCodes).toEqual(['templates-unverifiable']);
        expect(getBody.warnings?.[0]).toContain(
          'unv/.ok/templates could not be inspected (EACCES)',
        );
      } finally {
        chmodSync(ancestorOk, 0o755);
      }
    },
  );

  test('template PUT refuses an in-root symlinked template LEAF before any write', async () => {
    mkdirSync(join(contentDir, '.claude'), { recursive: true });
    writeFileSync(join(contentDir, '.claude', 'CLAUDE.md'), '# victim agent definition\n');
    mkdirSync(join(contentDir, 'notes', '.ok', 'templates'), { recursive: true });
    const leaf = join(contentDir, 'notes', '.ok', 'templates', 'meeting.md');
    symlinkSync('../../../.claude/CLAUDE.md', leaf);
    const ext = buildExt();

    const put = await dispatch(ext, '/api/template', 'PUT', {
      folder: 'notes',
      name: 'meeting',
      body: '# overwritten\n',
      frontmatter: { title: 'Meeting' },
    });
    expect(put.status).toBe(400);
    expect(JSON.parse(put.body).type).toBe('urn:ok:error:symlink-refused');
    expect(lstatSync(leaf).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(contentDir, '.claude', 'CLAUDE.md'), 'utf-8')).toBe(
      '# victim agent definition\n',
    );
  });

  test('PUT refuses an in-root symlinked .ok directory and writes nothing through it', async () => {
    mkdirSync(join(contentDir, 'secretdir2'), { recursive: true });
    writeFileSync(join(contentDir, 'secretdir2', 'frontmatter.yml'), 'existing: keep\n');
    mkdirSync(join(contentDir, 'aliased2'), { recursive: true });
    symlinkSync('../secretdir2', join(contentDir, 'aliased2', '.ok'), 'dir');
    const ext = buildExt();
    const captured = await dispatch(ext, '/api/folder-config', 'PUT', {
      path: 'aliased2',
      frontmatter: { status: 'draft' },
    });
    expect(captured.status).toBe(400);
    expect(JSON.parse(captured.body).type).toBe('urn:ok:error:symlink-refused');
    expect(readFileSync(join(contentDir, 'secretdir2', 'frontmatter.yml'), 'utf-8')).toBe(
      'existing: keep\n',
    );
  });

  test('PUT refuses a folder that symlinks out of the content root', async () => {
    const outside = join(tmpDir, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(contentDir, 'escape'), 'dir');
    const ext = buildExt();
    const captured = await dispatch(ext, '/api/folder-config', 'PUT', {
      path: 'escape/x',
      frontmatter: { status: 'draft' },
    });
    expect(captured.status).toBe(400);
    expect(JSON.parse(captured.body).type).toBe('urn:ok:error:path-escape');
    expect(existsSync(join(outside, 'x', '.ok', 'frontmatter.yml'))).toBe(false);
  });

  test('PUT refuses a REAL folder whose .ok is a symlink out of the content root', async () => {
    const outside = join(tmpDir, 'outside-okdir');
    mkdirSync(outside);
    mkdirSync(join(contentDir, 'notes-real'));
    symlinkSync(outside, join(contentDir, 'notes-real', '.ok'), 'dir');
    const ext = buildExt();
    const captured = await dispatch(ext, '/api/folder-config', 'PUT', {
      path: 'notes-real',
      frontmatter: { status: 'draft' },
    });
    expect(captured.status).toBe(400);
    expect(JSON.parse(captured.body).type).toBe('urn:ok:error:symlink-refused');
    expect(existsSync(join(outside, 'frontmatter.yml'))).toBe(false);
  });

  test('PUT surfaces a missing content root as a 500, not a 400', async () => {
    const ext = buildExt();
    rmSync(contentDir, { recursive: true, force: true });
    const captured = await dispatch(ext, '/api/folder-config', 'PUT', {
      path: 'plain',
      frontmatter: { status: 'draft' },
    });
    expect(captured.status).toBe(500);
    expect(JSON.parse(captured.body).type).toBe('urn:ok:error:internal-server-error');
  });

  test('PUT no longer rejects a folder whose own .ok/templates resolves outside the content root (the write never touches it)', async () => {
    const outside = join(tmpDir, 'outside-tpl-put');
    mkdirSync(outside);
    mkdirSync(join(contentDir, 'escput', '.ok'), { recursive: true });
    symlinkSync(outside, join(contentDir, 'escput', '.ok', 'templates'), 'dir');
    const put = await dispatch(buildExt(), '/api/folder-config', 'PUT', {
      path: 'escput',
      frontmatter: { status: 'draft' },
    });
    expect(put.status).toBe(200);
    expect(JSON.parse(put.body).applied).toEqual([
      { path: 'escput/.ok/frontmatter.yml', action: 'written' },
    ]);
    expect(readFileSync(join(contentDir, 'escput', '.ok', 'frontmatter.yml'), 'utf-8')).toContain(
      'status: draft',
    );
    expect(existsSync(join(outside, 'frontmatter.yml'))).toBe(false);
  });

  test('PUT fails on a malformed frontmatter.yml and leaves it byte-identical', async () => {
    const fmPath = join(contentDir, 'broken', '.ok', 'frontmatter.yml');
    const before = readFileSync(fmPath, 'utf-8');
    const put = await dispatch(buildExt(), '/api/folder-config', 'PUT', {
      path: 'broken',
      frontmatter: { status: 'draft' },
    });
    expect(put.status).not.toBe(200);
    expect(readFileSync(fmPath, 'utf-8')).toBe(before);
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
