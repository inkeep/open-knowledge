import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import {
  DEFAULT_LINKS_VALIDATION,
  DEFAULT_SUPPRESS_LOG_LINK_ADVISORIES,
} from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  AGENT_WRITE_ORIGIN,
  AgentSessionManager,
  applyAgentMarkdownWrite,
} from './agent-sessions.ts';
import { createDerivedDocumentIndexApiPortStub } from './api-extension.test-helper.ts';
import { createApiExtension } from './api-extension.ts';
import {
  DocumentDurabilityState,
  OK_DOC_REMOVED,
  OK_STORE_REFUSED,
} from './document-durability-state.ts';

interface CapturedResponse {
  status: number;
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

let projectDir: string;
let contentDir: string;
let hocuspocus: Hocuspocus;
let sessionManager: AgentSessionManager;
let durabilityState: DocumentDurabilityState;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'ok-batch-refusal-'));
  contentDir = join(projectDir, 'content');
  mkdirSync(contentDir, { recursive: true });
  hocuspocus = new Hocuspocus({ quiet: true });
  sessionManager = new AgentSessionManager(hocuspocus);
  durabilityState = new DocumentDurabilityState();
});

afterEach(async () => {
  await sessionManager.closeAll();
  rmSync(projectDir, { recursive: true, force: true });
});

function createExtension() {
  return createApiExtension({
    hocuspocus,
    durabilityState,
    sessionManager,
    contentDir,
    serverInstanceId: 'test-instance',
    getFileIndex: () => new Map(),
    getLinkAdvisoryPolicy: () => ({
      links: DEFAULT_LINKS_VALIDATION,
      suppressLogLinkAdvisories: DEFAULT_SUPPRESS_LOG_LINK_ADVISORIES,
    }),
    getProjectConfigEpoch: () => 0,
    derivedDocumentIndex: createDerivedDocumentIndexApiPortStub(),
  });
}

async function postBatch(body: unknown): Promise<CapturedResponse> {
  const ext = createExtension();
  const req = makeJsonPostReq('/api/agent-write-batch', body);
  const { res, captured } = makeRes();
  await (
    ext as unknown as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

describe('agent-write-batch — store-refused flush failure rendering', () => {
  test('a refused store renders the 503 store-refused contract instead of the generic lost-content error', async () => {
    const docName = 'batch-refused';
    const session = await sessionManager.getSession(docName);
    session.dc.document.transact(() => {
      applyAgentMarkdownWrite(
        session.dc.document,
        '# Batch refused\n\nOriginal body.\n',
        'replace',
      );
    }, AGENT_WRITE_ORIGIN);

    durabilityState.recordStoreFailure(docName, {
      code: OK_STORE_REFUSED,
      message: `duplication tripwire baseline unavailable for ${docName}; store refused (fail-closed)`,
    });

    const response = await postBatch({
      docs: [{ docName, markdown: '# Batch refused\n\nUpdated body.\n', position: 'replace' }],
      agentId: 'claude-1',
      agentName: 'Claude',
    });

    expect(response.status).toBe(200);
    const { results } = JSON.parse(response.body) as {
      results: Array<{
        status: string;
        docName: string;
        error?: { type: string; title: string; detail: string };
      }>;
    };
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('error');
    expect(results[0]?.docName).toBe(docName);
    expect(results[0]?.error?.type).toBe('urn:ok:error:store-refused');
    expect(results[0]?.error?.detail).toContain('recovery buffer');
    expect(results[0]?.error?.detail).toContain('filesystem fault');
    expect(results[0]?.error?.detail).not.toContain('will be lost');
  });

  test('a doc-removed flush failure keeps the doc-removed contract on the batch endpoint', async () => {
    const docName = 'batch-doc-removed';
    durabilityState.recordStoreFailure(docName, {
      code: OK_DOC_REMOVED,
      message: 'the document is no longer on disk',
    });

    const response = await postBatch({
      docs: [{ docName, markdown: '# Batch doc removed\n\nBody.\n', position: 'replace' }],
      agentId: 'claude-1',
      agentName: 'Claude',
    });

    expect(response.status).toBe(200);
    const { results } = JSON.parse(response.body) as {
      results: Array<{ status: string; error?: { type: string } }>;
    };
    expect(results[0]?.status).toBe('error');
    expect(results[0]?.error?.type).toBe('urn:ok:error:doc-removed');
  });
});
