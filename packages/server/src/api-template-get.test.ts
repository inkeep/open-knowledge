import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { createApiExtension } from './api-extension.test-helper.ts';

function makeReq(url: string): IncomingMessage {
  const readable = Readable.from(Buffer.from('')) as unknown as IncomingMessage;
  readable.method = 'GET';
  readable.url = url;
  readable.headers = { host: 'localhost' };
  return readable;
}

interface CapturedResponse {
  status: number;
  body: string;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: '' };
  const res = {
    writeHead(status: number) {
      captured.status = status;
    },
    end(body?: string) {
      captured.body = body ?? '';
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

async function getTemplate(
  contentDir: string,
  name: string,
  folder?: string,
): Promise<CapturedResponse> {
  const ext = createApiExtension({
    hocuspocus: {} as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
    sessionManager: {} as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
    contentDir,
    serverInstanceId: 'test-instance',
    getFileIndex: () => new Map(),
  });
  const folderQs = folder !== undefined ? `&folder=${encodeURIComponent(folder)}` : '';
  const req = makeReq(`/api/template?name=${name}${folderQs}`);
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

interface TemplateGetBody {
  template?: { frontmatter?: Record<string, unknown>; body?: string };
}

describe('GET /api/template — fence trailing whitespace (fm-delimiter hazard)', () => {
  test('parses template frontmatter whose opening fence carries a trailing space', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-template-get-'));
    try {
      mkdirSync(join(dir, '.ok/templates'), { recursive: true });
      writeFileSync(
        join(dir, '.ok/templates/trip-log.md'),
        '--- \ntitle: Trip Log\ndescription: Catch log\n---\n\n# {{date}}\n',
        'utf-8',
      );

      const result = await getTemplate(dir, 'trip-log');

      expect(result.status).toBe(200);
      const body = JSON.parse(result.body) as TemplateGetBody;
      expect(body.template?.frontmatter).toEqual({
        title: 'Trip Log',
        description: 'Catch log',
      });
      expect(body.template?.body).not.toContain('title: Trip Log');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('parses template frontmatter whose closing fence carries a trailing tab', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-template-get-'));
    try {
      mkdirSync(join(dir, '.ok/templates'), { recursive: true });
      writeFileSync(
        join(dir, '.ok/templates/standup.md'),
        '---\ntitle: Standup\n---\t\n\n# Notes\n',
        'utf-8',
      );

      const result = await getTemplate(dir, 'standup');

      expect(result.status).toBe(200);
      const body = JSON.parse(result.body) as TemplateGetBody;
      expect(body.template?.frontmatter).toEqual({ title: 'Standup' });
      expect(body.template?.body).not.toContain('title: Standup');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a leading space before the opening fence still means no frontmatter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-template-get-'));
    try {
      mkdirSync(join(dir, '.ok/templates'), { recursive: true });
      writeFileSync(
        join(dir, '.ok/templates/indented.md'),
        ' ---\ntitle: Not FM\n---\n\n# Notes\n',
        'utf-8',
      );

      const result = await getTemplate(dir, 'indented');

      expect(result.status).toBe(200);
      const body = JSON.parse(result.body) as TemplateGetBody;
      expect(body.template?.frontmatter).toEqual({});
      expect(body.template?.body).toContain('title: Not FM');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GET /api/template — symlinked leaf refusal', () => {
  test('refuses a template leaf that is a symlink and leaks none of the target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-template-get-'));
    try {
      const secret = join(dir, 'planted-key');
      writeFileSync(secret, 'PRIVATE-KEY-MATERIAL-do-not-leak\n', 'utf-8');
      mkdirSync(join(dir, '.ok/templates'), { recursive: true });
      symlinkSync(secret, join(dir, '.ok/templates/stolen.md'));

      const result = await getTemplate(dir, 'stolen');

      expect(result.status).toBe(400);
      expect(JSON.parse(result.body).type).toBe('urn:ok:error:symlink-refused');
      expect(result.body).not.toContain('PRIVATE-KEY-MATERIAL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses an in-root symlinked template leaf (leaf identity, not containment)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-template-get-'));
    try {
      writeFileSync(join(dir, 'ordinary.md'), '# In-root but not a template\n', 'utf-8');
      mkdirSync(join(dir, '.ok/templates'), { recursive: true });
      symlinkSync('../../ordinary.md', join(dir, '.ok/templates/aliased.md'));

      const result = await getTemplate(dir, 'aliased');

      expect(result.status).toBe(400);
      expect(JSON.parse(result.body).type).toBe('urn:ok:error:symlink-refused');
      expect(result.body).not.toContain('In-root but not a template');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses a symlinked ANCESTOR .ok/templates reached via a descendant folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-template-get-'));
    const outside = mkdtempSync(join(tmpdir(), 'ok-template-outside-'));
    try {
      writeFileSync(join(outside, 'meeting.md'), 'PRIVATE-ANCESTOR-TARGET\n', 'utf-8');
      mkdirSync(join(dir, 'notes', '.ok'), { recursive: true });
      symlinkSync(outside, join(dir, 'notes', '.ok', 'templates'), 'dir');
      mkdirSync(join(dir, 'notes', 'sub'), { recursive: true });

      const result = await getTemplate(dir, 'meeting', 'notes/sub');

      expect(result.status).toBe(400);
      expect(JSON.parse(result.body).type).toBe('urn:ok:error:symlink-refused');
      expect(result.body).not.toContain('PRIVATE-ANCESTOR-TARGET');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('refuses an IN-ROOT symlinked .ok/templates (the case containment cannot see)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-template-get-'));
    try {
      mkdirSync(join(dir, '.claude'), { recursive: true });
      writeFileSync(join(dir, '.claude', 'CLAUDE.md'), 'IN-ROOT-HIDDEN-CONTENT\n', 'utf-8');
      mkdirSync(join(dir, '.ok'), { recursive: true });
      symlinkSync('../.claude', join(dir, '.ok', 'templates'), 'dir');

      const result = await getTemplate(dir, 'CLAUDE');

      expect(result.status).toBe(400);
      expect(JSON.parse(result.body).type).toBe('urn:ok:error:symlink-refused');
      expect(result.body).not.toContain('IN-ROOT-HIDDEN-CONTENT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a regular FILE named .ok on an ancestor is skipped like an absent one (ENOTDIR continues the walk)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-template-get-'));
    try {
      mkdirSync(join(dir, '.ok', 'templates'), { recursive: true });
      writeFileSync(join(dir, '.ok', 'templates', 'x.md'), '---\ntitle: X\n---\n# X\n', 'utf-8');
      mkdirSync(join(dir, 'a', 'b'), { recursive: true });
      writeFileSync(join(dir, 'a', '.ok'), 'a regular file, not a directory', 'utf-8');

      const result = await getTemplate(dir, 'x', 'a/b');

      expect(result.status).toBe(200);
      const body = JSON.parse(result.body) as TemplateGetBody;
      expect(body.template?.frontmatter).toEqual({ title: 'X' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses an in-root symlinked ancestor .ok via a descendant folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-template-get-'));
    try {
      mkdirSync(join(dir, 'secretdir', 'templates'), { recursive: true });
      writeFileSync(join(dir, 'secretdir', 'templates', 'note.md'), 'ALIASED-OK-DIR\n', 'utf-8');
      mkdirSync(join(dir, 'notes'), { recursive: true });
      symlinkSync('../secretdir', join(dir, 'notes', '.ok'), 'dir');
      mkdirSync(join(dir, 'notes', 'sub'), { recursive: true });

      const result = await getTemplate(dir, 'note', 'notes/sub');

      expect(result.status).toBe(400);
      expect(JSON.parse(result.body).type).toBe('urn:ok:error:symlink-refused');
      expect(result.body).not.toContain('ALIASED-OK-DIR');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
