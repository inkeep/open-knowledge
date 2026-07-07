/**
 * Tests for GET /api/template frontmatter partitioning — the handler-local
 * frontmatter parser (`parseTemplateFile`) must agree with core
 * `stripFrontmatter` about fence recognition, including fences carrying
 * trailing whitespace (the fm-delimiter-hazard class: `--- ` is one
 * in-tolerance keystroke away from `---`).
 *
 * Harness mirrors `api-pages.test.ts`: createApiExtension with stub
 * hocuspocus/sessionManager, dispatch through `onRequest`.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createApiExtension } from './api-extension.ts';

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

async function getTemplate(contentDir: string, name: string): Promise<CapturedResponse> {
  const ext = createApiExtension({
    hocuspocus: {} as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
    sessionManager: {} as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
    contentDir,
    serverInstanceId: 'test-instance',
    getFileIndex: () => new Map(),
  });
  const req = makeReq(`/api/template?name=${name}`);
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
      // The FM lines must not leak into the returned body.
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
