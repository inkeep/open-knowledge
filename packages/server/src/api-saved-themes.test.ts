import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { BASE16_SLOTS } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createApiExtension } from './api-extension.test-helper.ts';
import { savedThemesDir } from './saved-themes-store.ts';

/**
 * Handler-boundary coverage for the saved-theme routes: the renderer's HTTP
 * request flows through the real `onRequest` → route table → handler → store →
 * wire response. The store is isolated to a tempdir via the `homedirOverride`
 * seam `createApiExtension` already exposes, so no `os.homedir()` mutation.
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

/** A complete, valid scheme payload: sixteen distinct `#rrggbb` slots. */
function schemePayload(name: string, variant: 'dark' | 'light' = 'dark') {
  const palette = Object.fromEntries(
    BASE16_SLOTS.map((slot, i) => {
      const byte = (i * 16).toString(16).padStart(2, '0');
      return [slot, `#${byte}${byte}${byte}`];
    }),
  );
  return { name, variant, palette };
}

describe('/api/saved-themes + /api/saved-theme', () => {
  let home: string;
  let savedThemeLockTimeoutMs: number | undefined;

  function buildExt() {
    return createApiExtension({
      hocuspocus: {} as Parameters<typeof createApiExtension>[0]['hocuspocus'],
      sessionManager: {} as Parameters<typeof createApiExtension>[0]['sessionManager'],
      contentDir: home,
      serverInstanceId: 'test-server',
      getFileIndex: () => new Map(),
      homeDirOverride: home,
      savedThemeLockTimeoutMs,
    }) as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    };
  }

  async function dispatch(url: string, method: string, body?: unknown): Promise<CapturedResponse> {
    const { res, captured } = makeRes();
    await buildExt().onRequest({ request: makeReq(url, method, body), response: res });
    return captured;
  }

  function storeFiles(): string[] {
    const dir = savedThemesDir(home);
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }

  async function withContendedStoreLock<T>(fn: () => Promise<T>): Promise<T> {
    const rootKey = createHash('sha256')
      .update(resolve(savedThemesDir(home)))
      .digest('hex')
      .slice(0, 24);
    const lockDir = join(home, '.ok');
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, `saved-themes-${rootKey}.lock`);
    writeFileSync(lockPath, '', { flag: 'wx', mode: 0o600 });
    try {
      return await fn();
    } finally {
      rmSync(lockPath, { force: true });
    }
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ok-api-saved-themes-'));
    savedThemeLockTimeoutMs = undefined;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('GET list of an absent store is an empty, un-truncated list (no error)', async () => {
    const res = await dispatch('/api/saved-themes', 'GET');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ themes: [], truncated: false });
  });

  test('GET lists usable themes and surfaces a malformed file as a warning entry', async () => {
    const dir = savedThemesDir(home);
    mkdirSync(dir, { recursive: true });
    const good = `name: "Good"\nvariant: "dark"\npalette:\n${BASE16_SLOTS.map(
      (s, i) => `  ${s}: "#${(i * 16).toString(16).padStart(2, '0').repeat(3)}"`,
    ).join('\n')}\n`;
    writeFileSync(join(dir, 'good.yaml'), good);
    writeFileSync(join(dir, 'broken.yaml'), 'name: "Broken"\npalette:\n  base00: "#000000"\n');

    const res = await dispatch('/api/saved-themes', 'GET');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      themes: Array<{ ok: boolean; id?: string; filename: string; code?: string }>;
      truncated: boolean;
    };
    const byKey = new Map(body.themes.map((t) => [t.ok ? t.id : t.filename, t]));
    expect(byKey.get('saved-good')).toMatchObject({ ok: true, filename: 'good.yaml' });
    // The malformed file is listed, not hidden — carrying its machine-readable reason.
    expect(byKey.get('broken.yaml')).toMatchObject({ ok: false, code: 'missing-slots' });
  });

  test('GET remains 200 and warns for a hand-dropped U+0085-only theme name', async () => {
    const dir = savedThemesDir(home);
    mkdirSync(dir, { recursive: true });
    const palette = BASE16_SLOTS.map((slot) => `  ${slot}: "#123456"`).join('\n');
    writeFileSync(
      join(dir, 'blank-name.yaml'),
      `name: "\\u0085"\nvariant: "dark"\npalette:\n${palette}\n`,
    );

    const res = await dispatch('/api/saved-themes', 'GET');

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      themes: [
        {
          ok: false,
          filename: 'blank-name.yaml',
          id: 'saved-blank-name',
          code: 'not-a-scheme',
        },
      ],
      truncated: false,
    });
  });

  test('GET carries every filename that claims a duplicate identity', async () => {
    const dir = savedThemesDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'conflict.yaml'), 'placeholder');
    writeFileSync(join(dir, 'conflict.yml'), 'placeholder');

    const res = await dispatch('/api/saved-themes', 'GET');

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).themes).toEqual([
      {
        ok: false,
        id: 'saved-conflict',
        filename: 'conflict.yaml',
        code: 'duplicate-identity',
        conflictingFilenames: ['conflict.yaml', 'conflict.yml'],
      },
    ]);
  });

  test('POST saves a palette and returns 201 with the id + filename', async () => {
    const res = await dispatch('/api/saved-theme', 'POST', {
      name: 'midnight',
      scheme: schemePayload('Midnight'),
    });
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ id: 'saved-midnight', filename: 'midnight.yaml' });
    expect(storeFiles()).toEqual(['midnight.yaml']);
  });

  test('POST derives a safe id from the display name while preserving that name', async () => {
    const res = await dispatch('/api/saved-theme', 'POST', {
      name: "John's theme",
      scheme: schemePayload("John's theme"),
    });
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body)).toEqual({
      id: 'saved-johns-theme',
      filename: 'johns-theme.yaml',
    });

    const listed = await dispatch('/api/saved-themes', 'GET');
    expect(JSON.parse(listed.body).themes).toContainEqual(
      expect.objectContaining({
        ok: true,
        id: 'saved-johns-theme',
        scheme: expect.objectContaining({ name: "John's theme" }),
      }),
    );
  });

  test('POST then GET preserves line breaks, tabs, and control characters in metadata', async () => {
    const name = 'Line one\nLine two\twith controls \u0001 and \u007f';
    const author = 'Ada\r\nLovelace\twith controls \u0085 and \u009f plus \u2028 a line separator';
    const scheme = { ...schemePayload(name), author };

    const saved = await dispatch('/api/saved-theme', 'POST', {
      name: 'escaped metadata',
      scheme,
    });
    expect(saved.status).toBe(201);

    const listed = await dispatch('/api/saved-themes', 'GET');
    expect(listed.status).toBe(200);
    expect(JSON.parse(listed.body).themes).toContainEqual(
      expect.objectContaining({
        ok: true,
        id: 'saved-escaped-metadata',
        scheme: expect.objectContaining({ name, author }),
      }),
    );
  });

  test('POST then GET preserves nonblank metadata boundary whitespace', async () => {
    const name = '  Padded theme\t';
    const author = '\t Ada Lovelace \n';

    const saved = await dispatch('/api/saved-theme', 'POST', {
      name: 'boundary whitespace',
      scheme: { ...schemePayload(name), author },
    });
    expect(saved.status).toBe(201);

    const listed = await dispatch('/api/saved-themes', 'GET');
    expect(listed.status).toBe(200);
    expect(JSON.parse(listed.body).themes).toContainEqual(
      expect.objectContaining({
        ok: true,
        id: 'saved-boundary-whitespace',
        scheme: expect.objectContaining({ name, author }),
      }),
    );
  });

  test.each([
    ['ASCII whitespace-only name', { ...schemePayload('   '), author: 'Ada' }],
    ['ASCII whitespace-only author', { ...schemePayload('Valid'), author: '\t \n' }],
    ['U+0085 NEXT LINE-only name', { ...schemePayload('\u0085'), author: 'Ada' }],
    ['U+0085 NEXT LINE-only author', { ...schemePayload('Valid'), author: '\u0085' }],
  ])('POST rejects a scheme with %s', async (_case, scheme) => {
    const res = await dispatch('/api/saved-theme', 'POST', {
      name: 'blank metadata',
      scheme,
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ type: 'urn:ok:error:invalid-request' });
    expect(storeFiles()).toEqual([]);
  });

  test('POST can preserve .yml when restoring a deleted theme', async () => {
    const res = await dispatch('/api/saved-theme', 'POST', {
      name: 'terse',
      scheme: schemePayload('Terse'),
      extension: '.yml',
    });

    expect(res.status).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ id: 'saved-terse', filename: 'terse.yml' });
    expect(storeFiles()).toEqual(['terse.yml']);
  });

  test('POST with a taken name is refused 409 theme-name-taken and writes nothing new', async () => {
    await dispatch('/api/saved-theme', 'POST', { name: 'dup', scheme: schemePayload('First') });

    const res = await dispatch('/api/saved-theme', 'POST', {
      name: 'dup',
      scheme: schemePayload('Second'),
    });
    expect(res.status).toBe(409);
    expect(res.headers['Content-Type']).toBe('application/problem+json');
    expect(JSON.parse(res.body)).toMatchObject({ type: 'urn:ok:error:theme-name-taken' });
    expect(storeFiles()).toEqual(['dup.yaml']);
  });

  test('POST with an invalid explicit restore stem is refused with the cause in detail', async () => {
    const res = await dispatch('/api/saved-theme', 'POST', {
      name: 'Restored theme',
      stem: 'a'.repeat(27),
      scheme: schemePayload('TooLong'),
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      type: 'urn:ok:error:theme-name-invalid',
      detail: 'too-long',
    });
    expect(storeFiles()).toEqual([]);
  });

  test('POST with a malformed scheme is refused as an invalid request', async () => {
    const res = await dispatch('/api/saved-theme', 'POST', {
      name: 'partial',
      scheme: { name: 'Partial', variant: 'dark', palette: { base00: '#000000' } },
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ type: 'urn:ok:error:invalid-request' });
    expect(storeFiles()).toEqual([]);
  });

  test('POST, PUT, and DELETE map store lock contention to retryable 503 responses', async () => {
    const dir = savedThemesDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'update.yaml'),
      `name: "Update"\nvariant: "dark"\npalette:\n${BASE16_SLOTS.map(
        (slot) => `  ${slot}: "#123456"`,
      ).join('\n')}\n`,
    );
    writeFileSync(
      join(dir, 'delete.yaml'),
      `name: "Delete"\nvariant: "dark"\npalette:\n${BASE16_SLOTS.map(
        (slot) => `  ${slot}: "#123456"`,
      ).join('\n')}\n`,
    );
    savedThemeLockTimeoutMs = 250;

    const responses = await withContendedStoreLock(() =>
      Promise.all([
        dispatch('/api/saved-theme', 'POST', {
          name: 'new-theme',
          scheme: schemePayload('New theme'),
        }),
        dispatch('/api/saved-theme', 'PUT', {
          id: 'saved-update',
          scheme: schemePayload('Update revised'),
        }),
        dispatch('/api/saved-theme?id=saved-delete', 'DELETE'),
      ]),
    );

    expect(
      responses.map((response) => ({
        status: response.status,
        headers: response.headers,
        body: JSON.parse(response.body),
      })),
    ).toEqual(
      responses.map(() =>
        expect.objectContaining({
          status: 503,
          headers: expect.objectContaining({ 'Retry-After': '5' }),
          body: expect.objectContaining({
            type: 'urn:ok:error:concurrent-operation',
            detail: 'lock-timeout',
          }),
        }),
      ),
    );
    expect(storeFiles()).toEqual(['delete.yaml', 'update.yaml']);
  });

  test('PUT replaces a saved palette in place and the next list returns the new scheme', async () => {
    await dispatch('/api/saved-theme', 'POST', {
      name: 'midnight',
      scheme: schemePayload('Midnight'),
    });
    const replacement = schemePayload('Midnight revised', 'light');
    replacement.palette.base00 = '#123456';

    const updated = await dispatch('/api/saved-theme', 'PUT', {
      id: 'saved-midnight',
      scheme: replacement,
    });

    expect(updated.status).toBe(200);
    expect(JSON.parse(updated.body)).toEqual({
      id: 'saved-midnight',
      filename: 'midnight.yaml',
    });
    expect(storeFiles()).toEqual(['midnight.yaml']);

    const listed = await dispatch('/api/saved-themes', 'GET');
    expect(JSON.parse(listed.body).themes).toEqual([
      expect.objectContaining({
        ok: true,
        id: 'saved-midnight',
        filename: 'midnight.yaml',
        scheme: expect.objectContaining({
          name: 'Midnight revised',
          variant: 'light',
          palette: expect.objectContaining({ base00: '#123456' }),
        }),
      }),
    ]);
  });

  test('PUT refuses an absent id rather than creating a new palette', async () => {
    const res = await dispatch('/api/saved-theme', 'PUT', {
      id: 'saved-absent',
      scheme: schemePayload('Absent'),
    });

    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ type: 'urn:ok:error:not-found' });
    expect(storeFiles()).toEqual([]);
  });

  test('PUT reports an unsafe existing target as a 409 conflict', async () => {
    const dir = savedThemesDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ocean.YAML'), 'user-owned unsupported file');

    const res = await dispatch('/api/saved-theme', 'PUT', {
      id: 'saved-ocean',
      scheme: schemePayload('Ocean revised'),
    });

    expect(res.status).toBe(409);
    expect(JSON.parse(res.body)).toMatchObject({
      type: 'urn:ok:error:invalid-request',
      title: 'The saved theme id conflicts with a file that cannot be safely updated.',
      detail: 'unsafe-target',
    });
    expect(storeFiles()).toEqual(['ocean.YAML']);
  });

  test('DELETE removes the file and returns existed:true', async () => {
    await dispatch('/api/saved-theme', 'POST', { name: 'gone', scheme: schemePayload('Gone') });

    const res = await dispatch('/api/saved-theme?id=saved-gone', 'DELETE');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      existed: true,
      filename: 'gone.yaml',
      scheme: schemePayload('Gone'),
    });
    expect(storeFiles()).toEqual([]);
  });

  test('PUT and DELETE refuse a duplicate-stem identity without mutating either file', async () => {
    const dir = savedThemesDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'conflict.yaml'), 'original yaml');
    writeFileSync(join(dir, 'conflict.yml'), 'original yml');

    const update = await dispatch('/api/saved-theme', 'PUT', {
      id: 'saved-conflict',
      scheme: schemePayload('Revised'),
    });
    const deletion = await dispatch('/api/saved-theme?id=saved-conflict', 'DELETE');

    expect(update.status).toBe(409);
    expect(JSON.parse(update.body)).toMatchObject({ detail: 'ambiguous-id' });
    expect(deletion.status).toBe(409);
    expect(JSON.parse(deletion.body)).toMatchObject({ detail: 'ambiguous-id' });
    expect(storeFiles()).toEqual(['conflict.yaml', 'conflict.yml']);
  });

  test('DELETE of an id that names no file is a 200 no-op (existed:false)', async () => {
    const res = await dispatch('/api/saved-theme?id=saved-absent', 'DELETE');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ existed: false });
  });

  test('DELETE with a missing id is a 400', async () => {
    const res = await dispatch('/api/saved-theme', 'DELETE');
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ type: 'urn:ok:error:invalid-request' });
  });

  test('an unsupported method on /api/saved-theme is a 405', async () => {
    const res = await dispatch('/api/saved-theme', 'GET');
    expect(res.status).toBe(405);
    expect(JSON.parse(res.body)).toMatchObject({ type: 'urn:ok:error:method-not-allowed' });
  });
});
