import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  AGENT_WRITE_ORIGIN,
  AgentSessionManager,
  applyAgentMarkdownWrite,
} from './agent-sessions.ts';
import { createApiExtension } from './api-extension.test-helper.ts';

interface CapturedResponse {
  status: number;
  body: string;
}

interface LinkAdvisoryBody {
  brokenLinks?: { href: string }[];
  brokenLinkSuppression?: { reason: string; count: number };
}

function makeJsonPostReq(url: string, body: unknown): IncomingMessage {
  const readable = Readable.from(Buffer.from(JSON.stringify(body))) as unknown as IncomingMessage;
  readable.method = 'POST';
  readable.url = url;
  readable.headers = { host: 'localhost', 'content-type': 'application/json' };
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

const TWO_BROKEN_FORMS = '# Log\n\nSee [[ghost-doc]].\n\n![missing](./ghost-image.png)\n';

let projectDir: string;
let contentDir: string;
let hocuspocus: Hocuspocus;
let sessionManager: AgentSessionManager;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'ok-write-link-policy-'));
  contentDir = join(projectDir, 'content');
  mkdirSync(contentDir, { recursive: true });
  hocuspocus = new Hocuspocus({ quiet: true });
  sessionManager = new AgentSessionManager(hocuspocus);
});

afterEach(async () => {
  await sessionManager.closeAll();
  rmSync(projectDir, { recursive: true, force: true });
});

async function post(
  url: string,
  body: unknown,
  options: { suppressLogLinkAdvisories?: boolean } = {},
): Promise<CapturedResponse> {
  const ext = createApiExtension({
    hocuspocus,
    sessionManager,
    contentDir,
    getFileIndex: () => new Map(),
    ...(options.suppressLogLinkAdvisories === undefined
      ? {}
      : {
          getLinkAdvisoryPolicy: () => ({
            links: 'warning' as const,
            suppressLogLinkAdvisories: options.suppressLogLinkAdvisories as boolean,
          }),
        }),
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

async function writeMd(
  docName: string,
  markdown: string,
  options?: { suppressLogLinkAdvisories?: boolean },
): Promise<LinkAdvisoryBody> {
  const response = await post(
    '/api/agent-write-md',
    { docName, markdown, position: 'replace', agentId: 'claude-1', agentName: 'Claude' },
    options,
  );
  expect(response.status).toBe(200);
  return JSON.parse(response.body) as LinkAdvisoryBody;
}

async function seed(docName: string, markdown: string): Promise<void> {
  const session = await sessionManager.getSession(docName);
  session.dc.document.transact(() => {
    applyAgentMarkdownWrite(session.dc.document, markdown, 'replace');
  }, AGENT_WRITE_ORIGIN);
}

describe('write-time broken-link advisories under the reserved-log policy', () => {
  test('a reserved log withholds every detected link and reports how many were omitted', async () => {
    const body = await writeMd('log', TWO_BROKEN_FORMS);

    expect(body.brokenLinks).toEqual([]);
    expect(body.brokenLinkSuppression).toEqual({ reason: 'reserved-log-policy', count: 2 });
  });

  test('an ordinary document keeps its repair candidates and carries no suppression', async () => {
    const body = await writeMd('journal', TWO_BROKEN_FORMS);

    expect(body.brokenLinks?.map((link) => link.href)).toEqual([
      '[[ghost-doc]]',
      './ghost-image.png',
    ]);
    expect(body.brokenLinkSuppression).toBeUndefined();
  });

  test('the same reserved log reports its links again once the policy is switched off', async () => {
    const body = await writeMd('log', TWO_BROKEN_FORMS, { suppressLogLinkAdvisories: false });

    expect(body.brokenLinks?.map((link) => link.href)).toEqual([
      '[[ghost-doc]]',
      './ghost-image.png',
    ]);
    expect(body.brokenLinkSuppression).toBeUndefined();
  });

  test('reserved identity is exact: a nested log is suppressed, an uppercase LOG is not', async () => {
    const nested = await writeMd('notes/2026/log', TWO_BROKEN_FORMS);
    expect(nested.brokenLinks).toEqual([]);
    expect(nested.brokenLinkSuppression).toEqual({ reason: 'reserved-log-policy', count: 2 });

    const upper = await writeMd('notes/LOG', TWO_BROKEN_FORMS);
    expect(upper.brokenLinks).toHaveLength(2);
    expect(upper.brokenLinkSuppression).toBeUndefined();
  });

  test('a reserved log whose links all resolve reports no suppression', async () => {
    const body = await writeMd('log', '# Log\n\nNothing unresolved here.\n');

    expect(body.brokenLinks).toEqual([]);
    expect(body.brokenLinkSuppression).toBeUndefined();
  });

  test('the count is the post-dedup entry count, not the number of occurrences', async () => {
    const body = await writeMd(
      'log',
      '# Log\n\n[[ghost-doc]] and [[ghost-doc]] again, plus [[ghost-doc]].\n',
    );

    expect(body.brokenLinks).toEqual([]);
    expect(body.brokenLinkSuppression).toEqual({ reason: 'reserved-log-policy', count: 1 });
  });

  test('a patch to a reserved log projects the post-edit links the same way', async () => {
    await seed('log', TWO_BROKEN_FORMS);
    const response = await post('/api/agent-patch', {
      docName: 'log',
      find: 'See',
      replace: 'Still see',
      agentId: 'claude-1',
      agentName: 'Claude',
    });

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as LinkAdvisoryBody;
    expect(body.brokenLinks).toEqual([]);
    expect(body.brokenLinkSuppression).toEqual({ reason: 'reserved-log-policy', count: 2 });
  });

  test('a frontmatter patch to a reserved log projects the body links the same way', async () => {
    await seed('log', TWO_BROKEN_FORMS);
    const response = await post('/api/frontmatter-patch', {
      docName: 'log',
      patch: { title: 'Change log' },
      agentId: 'claude-1',
      agentName: 'Claude',
    });

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as LinkAdvisoryBody;
    expect(body.brokenLinks).toEqual([]);
    expect(body.brokenLinkSuppression).toEqual({ reason: 'reserved-log-policy', count: 2 });
  });

  test('every batch entry is projected by its own source document', async () => {
    const response = await post('/api/agent-write-batch', {
      docs: [
        { docName: 'log', markdown: TWO_BROKEN_FORMS, position: 'replace' },
        { docName: 'notes/log', markdown: TWO_BROKEN_FORMS, position: 'replace' },
        { docName: 'journal', markdown: TWO_BROKEN_FORMS, position: 'replace' },
      ],
      agentId: 'claude-1',
      agentName: 'Claude',
    });

    expect(response.status).toBe(200);
    const results = (JSON.parse(response.body) as { results: LinkAdvisoryBody[] }).results;
    expect(results.map((entry) => entry.brokenLinkSuppression)).toEqual([
      { reason: 'reserved-log-policy', count: 2 },
      { reason: 'reserved-log-policy', count: 2 },
      undefined,
    ]);
    expect(results.map((entry) => entry.brokenLinks?.length)).toEqual([0, 0, 2]);
  });

  test('a policy change during assembly cannot split one batch response', async () => {
    let effectivePolicy = true;
    let policyReads = 0;
    const ext = createApiExtension({
      hocuspocus,
      sessionManager,
      contentDir,
      getFileIndex: () => {
        effectivePolicy = false;
        return new Map();
      },
      getLinkAdvisoryPolicy: () => {
        policyReads += 1;
        return {
          links: 'warning',
          suppressLogLinkAdvisories: effectivePolicy,
        };
      },
    });
    const req = makeJsonPostReq('/api/agent-write-batch', {
      docs: [
        { docName: 'log', markdown: TWO_BROKEN_FORMS, position: 'replace' },
        { docName: 'notes/log', markdown: TWO_BROKEN_FORMS, position: 'replace' },
      ],
      agentId: 'claude-1',
      agentName: 'Claude',
    });
    const { res, captured } = makeRes();
    await (
      ext as {
        onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
      }
    ).onRequest({ request: req, response: res });

    expect(captured.status).toBe(200);
    const results = (JSON.parse(captured.body) as { results: LinkAdvisoryBody[] }).results;
    expect(policyReads).toBe(1);
    expect(effectivePolicy).toBe(false);
    expect(results.map((entry) => entry.brokenLinkSuppression)).toEqual([
      { reason: 'reserved-log-policy', count: 2 },
      { reason: 'reserved-log-policy', count: 2 },
    ]);
  });

  test('switching link validation off does not empty an ordinary write advisory', async () => {
    const ext = createApiExtension({
      hocuspocus,
      sessionManager,
      contentDir,
      getFileIndex: () => new Map(),
      getLinkAdvisoryPolicy: () => ({
        links: 'off',
        suppressLogLinkAdvisories: true,
      }),
    });
    const req = makeJsonPostReq('/api/agent-write-md', {
      docName: 'journal',
      markdown: TWO_BROKEN_FORMS,
      position: 'replace',
      agentId: 'claude-1',
      agentName: 'Claude',
    });
    const { res, captured } = makeRes();
    await (
      ext as {
        onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
      }
    ).onRequest({ request: req, response: res });

    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body) as LinkAdvisoryBody;
    expect(body.brokenLinks).toHaveLength(2);
    expect(body.brokenLinkSuppression).toBeUndefined();
  });
});
