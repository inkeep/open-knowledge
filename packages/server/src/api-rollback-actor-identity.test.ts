import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { Principal } from '@inkeep/open-knowledge-core';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { createApiExtension } from './api-extension.test-helper.ts';
import { BacklinkIndex } from './backlink-index.ts';
import {
  type ContributorEntry,
  __formatContributorsForTests as formatContributorsForTest,
  __resetContributorsForTests as resetContributorsForTest,
} from './contributor-tracker.ts';
import { commitWip, initShadowRepo, type ShadowRef, type WriterIdentity } from './shadow-repo.ts';

interface CapturedResponse {
  status: number;
  body: string;
}

const fixturePrincipal: Principal = {
  id: 'principal-test-fixture-1234',
  display_name: 'Miles',
  display_email: 'miles@example.test',
  source: 'git-config',
  created_at: '2026-04-29T10:00:00.000Z',
};

function makeReq(url: string, method: string, body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const readable = Readable.from(Buffer.from(raw)) as unknown as IncomingMessage;
  readable.method = method;
  readable.url = url;
  readable.headers = { host: 'localhost' };
  return readable;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: '' };
  const res = {
    writeHead(status: number) {
      captured.status = status;
    },
    setHeader() {},
    end(body?: string) {
      captured.body = body ?? '';
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

interface RollbackHarness {
  contentDir: string;
  shadowRef: ShadowRef;
  hocuspocus: {
    documents: Map<string, Y.Doc>;
    closeConnections: () => void;
    unloadDocument: (doc: Y.Doc) => Promise<void>;
    debouncer: {
      isDebounced: () => boolean;
      executeNow: () => Promise<void>;
    };
  };
  priorSha: string;
  docName: string;
  callRollback: (body: unknown, getPrincipal?: () => Principal | null) => Promise<CapturedResponse>;
}

async function setupRollback(tmpDir: string): Promise<RollbackHarness> {
  const projectDir = tmpDir;
  const contentDir = resolve(tmpDir, 'content');
  mkdirSync(contentDir, { recursive: true });

  const docName = 'notes';
  const initialContent = '# Initial\n\nVersion 1 content\n';
  writeFileSync(resolve(contentDir, `${docName}.md`), initialContent);

  const git = simpleGit(projectDir);
  await git.init();
  await git.addConfig('user.name', 'Test User');
  await git.addConfig('user.email', 'test@example.com');
  await git.add('.');
  await git.commit('initial');

  const shadow = await initShadowRepo(projectDir);

  const writer: WriterIdentity = {
    id: 'principal-test-fixture-1234',
    name: 'Miles',
    email: 'miles@example.test',
  };
  const branch = (await simpleGit(projectDir).revparse(['--abbrev-ref', 'HEAD'])).trim();
  const priorSha = await commitWip(shadow, writer, 'content', 'WIP test prior version', branch);

  const newContent = '# Initial\n\nVersion 2 content (modified)\n';
  writeFileSync(resolve(contentDir, `${docName}.md`), newContent);

  const yDoc = new Y.Doc();
  const xmlFragment = yDoc.getXmlFragment('default');
  const para = new Y.XmlElement('paragraph');
  para.insert(0, [new Y.XmlText('Version 2 content (modified)')]);
  xmlFragment.insert(0, [para]);
  yDoc.getText('source').insert(0, newContent);

  const shadowRef: ShadowRef = { current: shadow };
  const hocuspocus: RollbackHarness['hocuspocus'] = {
    documents: new Map([[docName, yDoc]]),
    closeConnections() {},
    unloadDocument: async () => {},
    debouncer: {
      isDebounced: () => false,
      executeNow: async () => undefined,
    },
  };

  const callRollback: RollbackHarness['callRollback'] = async (body, getPrincipal) => {
    const ext = createApiExtension({
      hocuspocus: hocuspocus as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
      sessionManager: {
        closeSession: async () => {},
        closeAllForDoc: async () => {},
      } as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
      contentDir,
      contentRoot: 'content',
      shadowRef,
      getFileIndex: () => new Map(),
      backlinkIndex: new BacklinkIndex({ projectDir, contentDir }),
      ...(getPrincipal ? { getPrincipal } : {}),
    });
    const req = makeReq('/api/rollback', 'POST', body);
    const { res, captured } = makeRes();
    await (
      ext as {
        onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
      }
    ).onRequest({ request: req, response: res });
    return captured;
  };

  return {
    contentDir,
    shadowRef,
    hocuspocus,
    priorSha,
    docName,
    callRollback,
  };
}

function parseContributorLines(formatted: string): ContributorEntry[] {
  const entries: ContributorEntry[] = [];
  for (const line of formatted.split('\n')) {
    if (!line.startsWith('ok-contributors: ')) continue;
    const payload = JSON.parse(line.slice('ok-contributors: '.length));
    entries.push({
      writerId: payload.id,
      displayName: payload.name,
      colorSeed: payload.colorSeed,
      docs: new Set(payload.docs),
      summaries: payload.summaries ?? [],
    });
  }
  return entries;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ok-rollback-actor-'));
  resetContributorsForTest();
});

afterEach(() => {
  resetContributorsForTest();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('handleRollback — actor identity routing (D22-A, FR7b, D-A10)', () => {
  test('no body identity + getPrincipal returns principal → records principal contributor', async () => {
    const h = await setupRollback(tmpDir);

    const response = await h.callRollback(
      { docName: h.docName, commitSha: h.priorSha },
      () => fixturePrincipal,
    );
    expect(response.status).toBe(200);

    const formatted = formatContributorsForTest();
    const entries = parseContributorLines(formatted);
    expect(entries).toHaveLength(1);
    expect(entries[0].writerId).toBe(fixturePrincipal.id);
    expect(entries[0].displayName).toBe(fixturePrincipal.display_name);
    expect(entries[0].docs.has(h.docName)).toBe(true);
  });

  test('no body identity + getPrincipal returns null → no contributor (anonymous)', async () => {
    const h = await setupRollback(tmpDir);

    const response = await h.callRollback(
      { docName: h.docName, commitSha: h.priorSha },
      () => null,
    );
    expect(response.status).toBe(200);
    expect(formatContributorsForTest()).toBe('');
  });

  test('body.agentId set + principal loaded → records agent contributor with actor.principalId', async () => {
    const h = await setupRollback(tmpDir);

    const response = await h.callRollback(
      {
        docName: h.docName,
        commitSha: h.priorSha,
        agentId: 'claude-1',
        agentName: 'Claude',
        clientName: 'claude-code',
      },
      () => fixturePrincipal,
    );
    expect(response.status).toBe(200);

    const formatted = formatContributorsForTest();
    const entries = parseContributorLines(formatted);
    expect(entries).toHaveLength(1);
    expect(entries[0].writerId).toBe('agent-claude-1');
    expect(entries[0].displayName).toBe('Claude');
  });

  test('agent rollback default summary "Restored to <sha>" lands on the contributor entry', async () => {
    const h = await setupRollback(tmpDir);

    const response = await h.callRollback(
      {
        docName: h.docName,
        commitSha: h.priorSha,
        agentId: 'claude-1',
      },
      () => fixturePrincipal,
    );
    expect(response.status).toBe(200);

    const formatted = formatContributorsForTest();
    const entries = parseContributorLines(formatted);
    expect(entries).toHaveLength(1);
    const expectedSummary = `Restored to ${h.priorSha.slice(0, 8)}`;
    expect(entries[0].summaries).toEqual([expectedSummary]);
  });

  test('principal rollback does NOT auto-generate a default summary bullet', async () => {
    const h = await setupRollback(tmpDir);

    const response = await h.callRollback(
      { docName: h.docName, commitSha: h.priorSha },
      () => fixturePrincipal,
    );
    expect(response.status).toBe(200);

    const formatted = formatContributorsForTest();
    const entries = parseContributorLines(formatted);
    expect(entries).toHaveLength(1);
    expect(entries[0].summaries).toEqual([]);
  });

  test('body-supplied principalId is silently ignored — server principal wins', async () => {
    const h = await setupRollback(tmpDir);

    const response = await h.callRollback(
      { docName: h.docName, commitSha: h.priorSha, principalId: 'principal-fake' },
      () => fixturePrincipal,
    );
    expect(response.status).toBe(200);

    const formatted = formatContributorsForTest();
    const entries = parseContributorLines(formatted);
    expect(entries).toHaveLength(1);
    expect(entries[0].writerId).toBe(fixturePrincipal.id);
  });

  test('non-string summary returns 400 before any side-effects', async () => {
    const h = await setupRollback(tmpDir);

    const response = await h.callRollback(
      { docName: h.docName, commitSha: h.priorSha, summary: 42 },
      () => fixturePrincipal,
    );
    expect(response.status).toBe(400);
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    expect(parsed.type).toBe('urn:ok:error:invalid-request');
    expect(typeof parsed.title).toBe('string');
    expect(formatContributorsForTest()).toBe('');
  });
});
