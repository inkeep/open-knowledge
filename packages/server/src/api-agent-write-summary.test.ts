import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import { AgentSessionManager, applyAgentMarkdownWrite } from './agent-sessions.ts';
import { createApiExtension } from './api-extension.ts';
import {
  __formatContributorsForTests as formatContributorsForTest,
  __resetContributorsForTests as resetContributorsForTest,
} from './contributor-tracker.ts';
import { getMetrics, resetMetrics } from './metrics.ts';

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function makeJsonPostReq(url: string, body: unknown): IncomingMessage {
  const readable = Readable.from(Buffer.from(JSON.stringify(body))) as unknown as IncomingMessage;
  readable.method = 'POST';
  readable.url = url;
  readable.headers = { host: 'localhost', 'content-type': 'application/json' };
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

async function callApi(
  hocuspocus: Hocuspocus,
  sessionManager: AgentSessionManager,
  contentDir: string,
  url: string,
  body: unknown,
): Promise<CapturedResponse> {
  const ext = createApiExtension({
    hocuspocus,
    sessionManager,
    contentDir,
    getFileIndex: () => new Map(),
  });
  const req = makeJsonPostReq(url, body);
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

describe('summary parameter — three agent-write endpoints (US-003)', () => {
  let projectDir: string;
  let contentDir: string;
  let hocuspocus: Hocuspocus;
  let sessionManager: AgentSessionManager;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'ok-api-summary-'));
    contentDir = join(projectDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    hocuspocus = new Hocuspocus({ quiet: true });
    sessionManager = new AgentSessionManager(hocuspocus);
    resetContributorsForTest();
    resetMetrics();
  });

  afterEach(async () => {
    await sessionManager.closeAll();
    rmSync(projectDir, { recursive: true, force: true });
  });

  describe('/api/agent-write-md', () => {
    test('summary absent → no summary in response, no counter on summariesProvided', async () => {
      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        {
          docName: 'test-doc',
          markdown: '# Hello\n',
          position: 'replace',
          agentId: 'claude-1',
          agentName: 'Claude',
        },
      );
      expect(response.status).toBe(200);
      const parsed = JSON.parse(response.body);
      // success body is flat — no `ok: true` wrapper.
      expect(parsed.timestamp).toBeDefined();
      expect(parsed.summary).toBeUndefined();
      const m = getMetrics();
      expect(m.agentWriteCalls).toBe(1);
      expect(m.summariesProvided).toBe(0);
      expect(m.summariesTruncated).toBe(0);
      expect(formatContributorsForTest()).not.toContain('summaries');
    });

    test('summary present and short → included in response without truncatedFrom', async () => {
      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        {
          docName: 'test-doc',
          markdown: '# Hello\n',
          position: 'replace',
          agentId: 'claude-1',
          agentName: 'Claude',
          summary: 'Fixed token-refresh race',
        },
      );
      expect(response.status).toBe(200);
      const parsed = JSON.parse(response.body);
      expect(parsed.summary).toEqual({ value: 'Fixed token-refresh race' });
      expect(parsed.summary.hint).toBeUndefined();
      const m = getMetrics();
      expect(m.summariesProvided).toBe(1);
      expect(m.summariesTruncated).toBe(0);
      expect(formatContributorsForTest()).toContain('"summaries":["Fixed token-refresh race"]');
    });

    test('summary exactly 80 chars → no truncation', async () => {
      const s = 'a'.repeat(80);
      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        {
          docName: 'test-doc',
          markdown: '# H\n',
          position: 'replace',
          agentId: 'claude-1',
          agentName: 'Claude',
          summary: s,
        },
      );
      const parsed = JSON.parse(response.body);
      expect(parsed.summary).toEqual({ value: s });
      expect(getMetrics().summariesTruncated).toBe(0);
    });

    test('summary >80 chars → truncated with hint + truncatedFrom', async () => {
      const s = 'x'.repeat(100);
      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        {
          docName: 'test-doc',
          markdown: '# H\n',
          position: 'replace',
          agentId: 'claude-1',
          agentName: 'Claude',
          summary: s,
        },
      );
      const parsed = JSON.parse(response.body);
      expect(parsed.summary.truncatedFrom).toBe(100);
      expect(parsed.summary.value).toBe(`${'x'.repeat(79)}…`);
      expect(parsed.summary.hint).toBe('Summary truncated from 100 chars to 80 (max 80).');
      expect(getMetrics().summariesTruncated).toBe(1);
    });

    test('summary wrong type → 400 with descriptive error, no metrics, no contributor', async () => {
      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        {
          docName: 'test-doc',
          markdown: '# H\n',
          position: 'replace',
          agentId: 'claude-1',
          agentName: 'Claude',
          summary: 42,
        },
      );
      expect(response.status).toBe(400);
      // schema rejects non-string summary at validateBody —
      // RFC 9457 problem+json shape (pre-identity, anonymous).
      const parsed = JSON.parse(response.body);
      expect(parsed.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.status).toBe(400);
      expect(parsed.title).toBeDefined();
      const m = getMetrics();
      expect(m.agentWriteCalls).toBe(0);
      expect(m.summariesProvided).toBe(0);
      expect(formatContributorsForTest()).toBe('');
    });

    test('summary empty string → treated as absent', async () => {
      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        {
          docName: 'test-doc',
          markdown: '# H\n',
          position: 'replace',
          agentId: 'claude-1',
          agentName: 'Claude',
          summary: '',
        },
      );
      expect(response.status).toBe(200);
      const parsed = JSON.parse(response.body);
      expect(parsed.summary).toBeUndefined();
      expect(getMetrics().summariesProvided).toBe(0);
    });

    test('summary 80 chars exact → stored as-is, no hint (D20 edge)', async () => {
      // Exactly-at-cap must NOT emit `truncatedFrom` or `hint`.
      // Guards against off-by-one regressions in `normalizeSummary` (e.g.
      // `raw.length >= MAX_SUMMARY_LENGTH` vs `> MAX_SUMMARY_LENGTH`).
      const s = 'z'.repeat(80);
      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        {
          docName: 'test-doc',
          markdown: '# H\n',
          position: 'replace',
          agentId: 'claude-1',
          agentName: 'Claude',
          summary: s,
        },
      );
      const parsed = JSON.parse(response.body);
      expect(parsed.summary).toEqual({ value: s });
      expect(parsed.summary.hint).toBeUndefined();
      expect(parsed.summary.truncatedFrom).toBeUndefined();
      expect(getMetrics().summariesTruncated).toBe(0);
    });

    test('summary whitespace-only string → treated as absent (no blank bullet)', async () => {
      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        {
          docName: 'test-doc',
          markdown: '# H\n',
          position: 'replace',
          agentId: 'claude-1',
          agentName: 'Claude',
          summary: '   \t\n  ',
        },
      );
      expect(response.status).toBe(200);
      const parsed = JSON.parse(response.body);
      expect(parsed.summary).toBeUndefined();
      const m = getMetrics();
      expect(m.summariesProvided).toBe(0);
      expect(m.summariesTruncated).toBe(0);
      // Underlying contributor row should NOT carry a whitespace summary.
      expect(formatContributorsForTest()).not.toContain('"summaries"');
    });

    test('summary as JSON array → 400 (invalid, not auto-joined)', async () => {
      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        {
          docName: 'test-doc',
          markdown: '# H\n',
          position: 'replace',
          agentId: 'claude-1',
          agentName: 'Claude',
          summary: ['first', 'second'],
        },
      );
      expect(response.status).toBe(400);
      const parsed = JSON.parse(response.body);
      expect(parsed.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.status).toBe(400);
      const m = getMetrics();
      expect(m.agentWriteCalls).toBe(0);
      expect(m.summariesProvided).toBe(0);
      expect(formatContributorsForTest()).toBe('');
    });

    test('multiple writes coalesce summaries into a single contributor entry', async () => {
      for (const s of ['First', 'Second', 'Third']) {
        await callApi(hocuspocus, sessionManager, contentDir, '/api/agent-write-md', {
          docName: 'test-doc',
          markdown: '# H\n',
          position: 'replace',
          agentId: 'claude-1',
          agentName: 'Claude',
          summary: s,
        });
      }
      expect(formatContributorsForTest()).toContain('"summaries":["First","Second","Third"]');
      expect(getMetrics().agentWriteCalls).toBe(3);
      expect(getMetrics().summariesProvided).toBe(3);
    });
  });

  describe('/api/agent-write (legacy endpoint)', () => {
    test('summary flows through and counter increments (parity with write-md per D19)', async () => {
      const response = await callApi(hocuspocus, sessionManager, contentDir, '/api/agent-write', {
        docName: 'test-doc',
        content: 'Hello world',
        agentId: 'claude-1',
        agentName: 'Claude',
        summary: 'Fixed typo',
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body).summary).toEqual({ value: 'Fixed typo' });
      expect(getMetrics().summariesProvided).toBe(1);
    });
  });

  describe('/api/agent-patch', () => {
    test('404 "not found" does NOT increment counters or fire contributor', async () => {
      // Seed a doc first — post-foundation getSession returns a SessionRecord
      // wrapping the DirectConnection + per-session origin (precedent #24).
      const session = await sessionManager.getSession('test-doc');
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, '# H\n', 'replace');
      }, session.origin);

      const response = await callApi(hocuspocus, sessionManager, contentDir, '/api/agent-patch', {
        docName: 'test-doc',
        find: 'NONEXISTENT',
        replace: 'x',
        agentId: 'claude-1',
        agentName: 'Claude',
        summary: 'Some summary',
      });
      expect(response.status).toBe(404);
      const m = getMetrics();
      expect(m.agentWriteCalls).toBe(0);
      expect(m.summariesProvided).toBe(0);
      expect(formatContributorsForTest()).toBe('');
    });

    test('successful patch with summary records it and responds with truncatedFrom when truncated', async () => {
      const session = await sessionManager.getSession('test-doc');
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, 'old text\n', 'replace');
      }, session.origin);

      const longSummary = 'y'.repeat(100);
      const response = await callApi(hocuspocus, sessionManager, contentDir, '/api/agent-patch', {
        docName: 'test-doc',
        find: 'old',
        replace: 'new',
        agentId: 'claude-1',
        agentName: 'Claude',
        summary: longSummary,
      });
      expect(response.status).toBe(200);
      const parsed = JSON.parse(response.body);
      expect(parsed.summary.truncatedFrom).toBe(100);
      expect(parsed.summary.hint).toContain('truncated');
      expect(getMetrics().agentWriteCalls).toBe(1);
      expect(getMetrics().summariesProvided).toBe(1);
      expect(getMetrics().summariesTruncated).toBe(1);
    });

    test('summary wrong type → 400, no counters, no contributor', async () => {
      const response = await callApi(hocuspocus, sessionManager, contentDir, '/api/agent-patch', {
        docName: 'test-doc',
        find: 'x',
        replace: 'y',
        agentId: 'claude-1',
        agentName: 'Claude',
        summary: { not: 'a string' },
      });
      expect(response.status).toBe(400);
      expect(getMetrics().agentWriteCalls).toBe(0);
    });
  });
});
