import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import { describe, expect, test } from 'vitest';
import type * as Y from 'yjs';
import {
  AGENT_WRITE_ORIGIN,
  AgentSessionManager,
  applyAgentMarkdownWrite,
} from './agent-sessions.ts';
import { createApiExtension } from './api-extension.test-helper.ts';

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function makeJsonPostReq(body: unknown): IncomingMessage {
  const readable = Readable.from(Buffer.from(JSON.stringify(body))) as unknown as IncomingMessage;
  readable.method = 'POST';
  readable.url = '/api/agent-patch';
  readable.headers = {
    host: 'localhost',
    'content-type': 'application/json',
  };
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

async function callAgentPatch(
  hocuspocus: Hocuspocus,
  sessionManager: AgentSessionManager,
  contentDir: string,
  body: unknown,
): Promise<CapturedResponse> {
  const ext = createApiExtension({
    hocuspocus,
    sessionManager,
    contentDir,
    getFileIndex: () => new Map(),
  });
  const req = makeJsonPostReq(body);
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

describe('POST /api/agent-patch', () => {
  test('patches the requested occurrence when offset matches', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-api-agent-patch-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });

    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus);

    try {
      const session = await sessionManager.getSession('test-doc');
      const ytext = session.dc.document.getText('source');
      const initial =
        '# Notes\n\nProject Alpha appears first. Later, Project Alpha appears second.\n';
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, initial, 'replace');
      }, AGENT_WRITE_ORIGIN);

      const secondOffset = initial.indexOf('Project Alpha', initial.indexOf('Project Alpha') + 1);
      const response = await callAgentPatch(hocuspocus, sessionManager, contentDir, {
        docName: 'test-doc',
        find: 'Project Alpha',
        replace: 'Project Alpha (linked)',
        offset: secondOffset,
      });

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        timestamp: expect.any(String),
        subscriberCount: expect.any(Number),
        systemSubscriberCount: expect.any(Number),
        brokenLinks: [],
      });
      expect(ytext.toString()).toBe(
        '# Notes\n\nProject Alpha appears first. Later, Project Alpha (linked) appears second.\n',
      );
    } finally {
      await sessionManager.closeAll();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('returns a stale-target error and leaves the document unchanged when offset drifts', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-api-agent-patch-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });

    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus);

    try {
      const session = await sessionManager.getSession('test-doc');
      const ytext = session.dc.document.getText('source');
      const initial =
        '# Notes\n\nProject Alpha appears first. Later, Project Alpha appears second.\n';
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, initial, 'replace');
      }, AGENT_WRITE_ORIGIN);

      const secondOffset = initial.indexOf('Project Alpha', initial.indexOf('Project Alpha') + 1);
      const response = await callAgentPatch(hocuspocus, sessionManager, contentDir, {
        docName: 'test-doc',
        find: 'Project Alpha',
        replace: 'Project Alpha (linked)',
        offset: secondOffset + 1,
      });

      expect(response.status).toBe(409);
      const parsed = JSON.parse(response.body);
      expect(parsed.type).toBe('urn:ok:error:stale-target');
      expect(parsed.status).toBe(409);
      expect(parsed.title).toBeDefined();
      expect(ytext.toString()).toBe(initial);
    } finally {
      await sessionManager.closeAll();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('preserves first-match behavior when offset is omitted', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-api-agent-patch-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });

    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus);

    try {
      const session = await sessionManager.getSession('test-doc');
      const ytext = session.dc.document.getText('source');
      const initial =
        '# Notes\n\nProject Alpha appears first. Later, Project Alpha appears second.\n';
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, initial, 'replace');
      }, AGENT_WRITE_ORIGIN);

      const response = await callAgentPatch(hocuspocus, sessionManager, contentDir, {
        docName: 'test-doc',
        find: 'Project Alpha',
        replace: 'Project Alpha (linked)',
      });

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        timestamp: expect.any(String),
        subscriberCount: expect.any(Number),
        systemSubscriberCount: expect.any(Number),
        brokenLinks: [],
      });
      expect(ytext.toString()).toBe(
        '# Notes\n\nProject Alpha (linked) appears first. Later, Project Alpha appears second.\n',
      );
    } finally {
      await sessionManager.closeAll();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('POST /api/agent-patch — surgical/incremental write shape', () => {
  test('a small find/replace produces a minimal Y.Text delta, not a whole-doc overwrite', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-api-agent-patch-shape-'));
    const contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });

    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus);

    try {
      const session = await sessionManager.getSession('test-doc');
      const ytext = session.dc.document.getText('source');
      const seed =
        '# Heading\n\n' +
        'Alpha paragraph one with several words of filler content here.\n\n' +
        'Beta paragraph two with the TARGET token buried in the middle.\n\n' +
        'Gamma paragraph three with several more words of filler content here.\n';
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, seed, 'replace');
      }, AGENT_WRITE_ORIGIN);
      expect(ytext.toString()).toBe(seed);
      const wholeDocLen = seed.length;

      let insertCharCount = 0;
      let deleteCharCount = 0;
      const observer = (event: Y.YTextEvent): void => {
        for (const change of event.changes.delta) {
          if (change.insert && typeof change.insert === 'string') {
            insertCharCount += change.insert.length;
          }
          if (change.delete) deleteCharCount += change.delete;
        }
      };
      ytext.observe(observer);
      const response = await callAgentPatch(hocuspocus, sessionManager, contentDir, {
        docName: 'test-doc',
        find: 'TARGET',
        replace: 'REPLACED-TOKEN',
      });
      ytext.unobserve(observer);

      expect(response.status).toBe(200);
      expect(ytext.toString()).toBe(seed.replace('TARGET', 'REPLACED-TOKEN'));
      const newDocLen = ytext.toString().length;

      expect(deleteCharCount).toBeLessThan(wholeDocLen);
      expect(insertCharCount).toBeLessThan(newDocLen);
      const changedLineOld = 'Beta paragraph two with the TARGET token buried in the middle.\n';
      const changedLineNew = changedLineOld.replace('TARGET', 'REPLACED-TOKEN');
      expect(deleteCharCount).toBeLessThanOrEqual(changedLineOld.length);
      expect(insertCharCount).toBeLessThanOrEqual(changedLineNew.length);
    } finally {
      await sessionManager.closeAll();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
