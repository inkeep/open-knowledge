import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import { describe, expect, test } from 'vitest';
import {
  AGENT_WRITE_ORIGIN,
  AgentSessionManager,
  applyAgentMarkdownWrite,
} from './agent-sessions.ts';
import { createApiExtension } from './api-extension.test-helper.ts';
import { getMetrics, resetMetrics } from './metrics.ts';

interface CapturedResponse {
  status: number;
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

interface TestEnv {
  projectDir: string;
  contentDir: string;
  hocuspocus: Hocuspocus;
  sessionManager: AgentSessionManager;
  cleanup: () => Promise<void>;
}

function setup(): TestEnv {
  const projectDir = mkdtempSync(join(tmpdir(), 'ok-agent-patch-ytext-'));
  const contentDir = join(projectDir, 'content');
  mkdirSync(contentDir, { recursive: true });

  const hocuspocus = new Hocuspocus({ quiet: true });
  const sessionManager = new AgentSessionManager(hocuspocus);
  return {
    projectDir,
    contentDir,
    hocuspocus,
    sessionManager,
    cleanup: async () => {
      await sessionManager.closeAll();
      rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

async function captureWarnAsync<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const result = await fn();
    return { result, warnings };
  } finally {
    console.warn = original;
  }
}

describe('POST /api/agent-patch — Y.Text-is-truth contract (FR-36)', () => {
  test('search surface IS ytext bytes — CRLF in body survives the patch flow', async () => {
    const env = setup();
    try {
      const session = await env.sessionManager.getSession('test-doc');
      const ytext = session.dc.document.getText('source');

      const initial = '__foo__\r\nBar appears here.\r\n';
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, initial, 'replace');
      }, AGENT_WRITE_ORIGIN);
      expect(ytext.toString()).toBe(initial);

      const response = await callAgentPatch(env.hocuspocus, env.sessionManager, env.contentDir, {
        docName: 'test-doc',
        find: 'Bar appears here.',
        replace: 'Baz appears here.',
      });

      expect(response.status).toBe(200);
      expect(ytext.toString()).toBe('__foo__\r\nBaz appears here.\r\n');
    } finally {
      await env.cleanup();
    }
  });

  test('search surface preserves doc-start `---` (no canonicalization to `***\\n\\n`)', async () => {
    const env = setup();
    try {
      const session = await env.sessionManager.getSession('test-doc');
      const ytext = session.dc.document.getText('source');

      const initial = '---\n# H\n\nSome paragraph.\n';
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, initial, 'replace');
      }, AGENT_WRITE_ORIGIN);
      expect(ytext.toString()).toBe(initial);

      const response = await callAgentPatch(env.hocuspocus, env.sessionManager, env.contentDir, {
        docName: 'test-doc',
        find: 'Some paragraph.',
        replace: 'Updated paragraph.',
      });

      expect(response.status).toBe(200);
      expect(ytext.toString()).toBe('---\n# H\n\nUpdated paragraph.\n');
      expect(ytext.toString().startsWith('---\n')).toBe(true);
      expect(ytext.toString().includes('***')).toBe(false);
    } finally {
      await env.cleanup();
    }
  });

  test('source-form delimiter (`__foo__`) is the find target — not the canonical `**foo**`', async () => {
    const env = setup();
    try {
      const session = await env.sessionManager.getSession('test-doc');
      const ytext = session.dc.document.getText('source');

      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(
          session.dc.document,
          'A line with __strong__ and _italic_ marks.\n',
          'replace',
        );
      }, AGENT_WRITE_ORIGIN);

      const response = await callAgentPatch(env.hocuspocus, env.sessionManager, env.contentDir, {
        docName: 'test-doc',
        find: '__strong__',
        replace: '__BOLD__',
      });

      expect(response.status).toBe(200);
      expect(ytext.toString()).toBe('A line with __BOLD__ and _italic_ marks.\n');
    } finally {
      await env.cleanup();
    }
  });

  test('find target miss emits agent-patch-find-mismatch telemetry + increments counter', async () => {
    const env = setup();
    try {
      const session = await env.sessionManager.getSession('test-doc');
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, '# Heading\n\nReal content.\n', 'replace');
      }, AGENT_WRITE_ORIGIN);

      resetMetrics();
      const before = getMetrics().agentPatchFindMismatches;

      const { result: response, warnings } = await captureWarnAsync(() =>
        callAgentPatch(env.hocuspocus, env.sessionManager, env.contentDir, {
          docName: 'test-doc',
          find: 'this string does not exist',
          replace: 'whatever',
        }),
      );

      expect(response.status).toBe(404);
      const after = getMetrics().agentPatchFindMismatches;
      expect(after).toBe(before + 1);

      const event = warnings
        .map((w) => {
          try {
            return JSON.parse(w);
          } catch {
            return null;
          }
        })
        .find((e) => e && e.event === 'agent-patch-find-mismatch');
      expect(event).toBeDefined();
      expect(event.event).toBe('agent-patch-find-mismatch');
      expect(event['doc.name']).toBe('test-doc');
      expect(event.findLength).toBe('this string does not exist'.length);
      expect(event.replaceLength).toBe('whatever'.length);
      expect(event.hadOffset).toBe(false);
      expect(JSON.stringify(event)).not.toContain('this string does not exist');
    } finally {
      await env.cleanup();
    }
  });

  test('stale offset emits agent-patch-find-mismatch telemetry with hadOffset=true', async () => {
    const env = setup();
    try {
      const session = await env.sessionManager.getSession('test-doc');
      const initial = '# Notes\n\nProject Alpha appears.\n';
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, initial, 'replace');
      }, AGENT_WRITE_ORIGIN);

      resetMetrics();
      const before = getMetrics().agentPatchFindMismatches;

      const correctOffset = initial.indexOf('Project Alpha');
      const { result: response, warnings } = await captureWarnAsync(() =>
        callAgentPatch(env.hocuspocus, env.sessionManager, env.contentDir, {
          docName: 'test-doc',
          find: 'Project Alpha',
          replace: 'Project Beta',
          offset: correctOffset + 5,
        }),
      );

      expect(response.status).toBe(409);
      expect(getMetrics().agentPatchFindMismatches).toBe(before + 1);

      const event = warnings
        .map((w) => {
          try {
            return JSON.parse(w);
          } catch {
            return null;
          }
        })
        .find((e) => e && e.event === 'agent-patch-find-mismatch');
      expect(event).toBeDefined();
      expect(event.hadOffset).toBe(true);
      expect(event.findLength).toBe('Project Alpha'.length);
      expect(event.replaceLength).toBe('Project Beta'.length);
    } finally {
      await env.cleanup();
    }
  });

  test('successful patch does NOT emit agent-patch-find-mismatch telemetry', async () => {
    const env = setup();
    try {
      const session = await env.sessionManager.getSession('test-doc');
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, '# H\n\nThe target.\n', 'replace');
      }, AGENT_WRITE_ORIGIN);

      resetMetrics();
      const before = getMetrics().agentPatchFindMismatches;

      const { result: response, warnings } = await captureWarnAsync(() =>
        callAgentPatch(env.hocuspocus, env.sessionManager, env.contentDir, {
          docName: 'test-doc',
          find: 'The target.',
          replace: 'A replaced phrase.',
        }),
      );

      expect(response.status).toBe(200);
      expect(getMetrics().agentPatchFindMismatches).toBe(before);

      const mismatchEvent = warnings
        .map((w) => {
          try {
            return JSON.parse(w);
          } catch {
            return null;
          }
        })
        .find((e) => e && e.event === 'agent-patch-find-mismatch');
      expect(mismatchEvent).toBeUndefined();
    } finally {
      await env.cleanup();
    }
  });
});
