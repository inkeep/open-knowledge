/**
 * end-to-end regression gate — the full handleAgentPatch flow under
 * a connected WYSIWYG client.
 *
 * The repro pinned the reporter's symptom:
 * "Text not found in document" (404) on the second sequential edit call,
 * because a non-paired WYSIWYG XmlFragment mutation fired Observer A which
 * rewrote Y.Text to the canonical serialize(fragment) form, destroying the
 * raw bytes the agent's `find` targets. This gate wires the exact production
 * path (Hocuspocus + server observer extension + the agent-patch HTTP
 * handler) and asserts the second find SUCCEEDS (200) — a byte round-trip
 * for the byte-requiring consumer, not tolerance-equivalence.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import { MarkdownManager, sharedExtensions } from '@inkeep/open-knowledge-core';
import { getSchema } from '@tiptap/core';
import * as Y from 'yjs';
import { AGENT_WRITE_ORIGIN, AgentSessionManager } from './agent-sessions.ts';
import { createApiExtension } from './api-extension.ts';
import { composeAndWriteRawBody } from './bridge-intake.ts';
import { createServerObserverExtension } from './server-observer-extension.ts';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });
const schema = getSchema(sharedExtensions);

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
    serverInstanceId: 'prd-6654-e2e-test-instance',
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

function setup() {
  const projectDir = mkdtempSync(join(tmpdir(), 'ok-prd-6654-e2e-'));
  const contentDir = join(projectDir, 'content');
  mkdirSync(contentDir, { recursive: true });
  // Wire the production observer extension so per-document Server Observer
  // A/B actually run — without it the canonicalization path is dormant and
  // the gate would pass vacuously.
  const hocuspocus = new Hocuspocus({
    quiet: true,
    extensions: [createServerObserverExtension({ mdManager, schema })],
  });
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

/**
 * Non-paired transaction origin simulating a WYSIWYG client touching the
 * XmlFragment. Uses `source: 'local'` (not 'connection') so Hocuspocus's
 * `handleDocumentUpdate` doesn't crash on the missing `origin.connection`
 * field — and omits `context.paired: true` so `isPairedWriteOrigin` returns
 * false and Observer A fires its non-paired branch. In production this same
 * branch fires for real WS updates from a WYSIWYG client (their origin shape
 * is `{ source: 'connection', connection }` and also lacks `paired: true`).
 */
const USER_TYPING_ORIGIN = {
  source: 'local' as const,
  context: { origin: 'user-typing' },
};

const SEED_ORIGIN = {
  source: 'local' as const,
  skipStoreHooks: false,
  context: { origin: 'test-seed', paired: true as const },
};

describe('PRD-6654 — full end-to-end gate (handleAgentPatch + WYSIWYG touch)', () => {
  test('row-without-trailing-pipe shape: the second find succeeds (200, no "Text not found")', async () => {
    const env = setup();
    try {
      const session = await env.sessionManager.getSession('test-doc');
      const ytext = session.dc.document.getText('source');
      const xmlFragment = session.dc.document.getXmlFragment('default');

      session.dc.document.transact(() => {
        ytext.delete(0, ytext.length);
        ytext.insert(0, '# Notes\n\nplaceholder\n');
      }, SEED_ORIGIN);

      const r0 = await callAgentPatch(env.hocuspocus, env.sessionManager, env.contentDir, {
        docName: 'test-doc',
        find: 'placeholder',
        replace: '| a | b |\n| - | - |\n| 1 | 2',
      });
      expect(r0.status).toBe(200);
      expect(ytext.toString().includes('| 1 | 2\n')).toBe(true);

      // WYSIWYG client touches the XmlFragment in a different block.
      session.dc.document.transact(() => {
        const para = new Y.XmlElement('paragraph');
        para.insert(0, [new Y.XmlText('hi')]);
        xmlFragment.insert(xmlFragment.length, [para]);
      }, USER_TYPING_ORIGIN);

      // The agent edits "what it just wrote" — the exact bytes from step 1.
      const r2 = await callAgentPatch(env.hocuspocus, env.sessionManager, env.contentDir, {
        docName: 'test-doc',
        find: '| 1 | 2\n',
        replace: '| 1 | 2\n| 3 | 4\n',
      });
      expect(r2.status).toBe(200);
      expect(ytext.toString().includes('| 3 | 4')).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  test('leading-blank-line shape: the second find succeeds (200)', async () => {
    const env = setup();
    try {
      const session = await env.sessionManager.getSession('test-doc');
      const ytext = session.dc.document.getText('source');
      const xmlFragment = session.dc.document.getXmlFragment('default');

      // Seed through the real paired-write primitive so BOTH CRDTs carry
      // the seeded state (a ytext-only seed leaves the fragment empty and
      // Observer A would legitimately reconcile toward the fragment).
      session.dc.document.transact(() => {
        composeAndWriteRawBody(session.dc.document, '\n\nhello\n', 'agent');
      }, AGENT_WRITE_ORIGIN);

      session.dc.document.transact(() => {
        const para = new Y.XmlElement('paragraph');
        para.insert(0, [new Y.XmlText('z')]);
        xmlFragment.insert(xmlFragment.length, [para]);
      }, USER_TYPING_ORIGIN);

      const r2 = await callAgentPatch(env.hocuspocus, env.sessionManager, env.contentDir, {
        docName: 'test-doc',
        find: '\n\nhello',
        replace: '\n\nGOODBYE',
      });
      expect(r2.status).toBe(200);
      expect(ytext.toString().includes('GOODBYE')).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  test('reporter scenario: 12 rapid sequential edits with interleaved WYSIWYG noise all succeed', async () => {
    const env = setup();
    try {
      const session = await env.sessionManager.getSession('test-doc');
      const ytext = session.dc.document.getText('source');
      const xmlFragment = session.dc.document.getXmlFragment('default');

      const seed = '# Trace\n\n| step | note |\n| ---- | ---- |\n| 0 | start |\n';
      session.dc.document.transact(() => {
        ytext.delete(0, ytext.length);
        ytext.insert(0, seed);
      }, SEED_ORIGIN);

      let prevRow = '| 0 | start |';
      let successes = 0;
      const failures: string[] = [];
      for (let i = 1; i <= 12; i++) {
        const newRow = `| ${i} | iter${i} |`;
        const r = await callAgentPatch(env.hocuspocus, env.sessionManager, env.contentDir, {
          docName: 'test-doc',
          find: prevRow,
          replace: `${prevRow}\n${newRow}`,
        });
        if (r.status === 200) {
          successes++;
          prevRow = newRow;
        } else {
          failures.push(`iter ${i}: status=${r.status} body=${r.body.slice(0, 120)}`);
        }
        // WYSIWYG noise: half the iterations get a non-paired touch.
        if (i % 2 === 0) {
          session.dc.document.transact(() => {
            const para = new Y.XmlElement('paragraph');
            para.insert(0, [new Y.XmlText(`n${i}`)]);
            xmlFragment.insert(xmlFragment.length, [para]);
          }, USER_TYPING_ORIGIN);
        }
      }

      expect(failures).toEqual([]);
      expect(successes).toBe(12);
    } finally {
      await env.cleanup();
    }
  });
});
