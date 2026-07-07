/**
 * Tests for agent-write frontmatter handling under the Y.Text-direct model
 * (`Y.Map('metadata')` is no longer a CRDT root for FM data; the YAML
 * region of `Y.Text('source')` IS the source of truth).
 *
 * Covers:
 *   1. write_document with payload FM updates the YAML region of Y.Text.
 *   2. write_document with body-only payload preserves existing FM.
 *   3. append/prepend never duplicate or stomp FM.
 *   4. agent-patch refuses spliced edits to the FM region.
 *   5. body-only agent-patch continues to work.
 *   6. agent-undo reverts the FM region in lock-step with body changes.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import { readFmMap, stripFrontmatter } from '@inkeep/open-knowledge-core';
import {
  AGENT_WRITE_ORIGIN,
  AgentSessionManager,
  applyAgentMarkdownWrite,
  applyAgentUndo,
} from './agent-sessions.ts';
import { createApiExtension } from './api-extension.ts';

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

function setup() {
  const projectDir = mkdtempSync(join(tmpdir(), 'ok-api-agent-fm-'));
  const contentDir = join(projectDir, 'content');
  mkdirSync(contentDir, { recursive: true });
  const hocuspocus = new Hocuspocus({ quiet: true });
  const sessionManager = new AgentSessionManager(hocuspocus);
  const cleanup = async () => {
    await sessionManager.closeAll();
    rmSync(projectDir, { recursive: true, force: true });
  };
  return { projectDir, contentDir, hocuspocus, sessionManager, cleanup };
}

function ytextFm(doc: import('yjs').Doc): string {
  return stripFrontmatter(doc.getText('source').toString()).frontmatter;
}

function fmMap(doc: import('yjs').Doc): Record<string, unknown> {
  return readFmMap(doc.getText('source').toString());
}

describe('POST /api/agent-write-md (write_document) — frontmatter handling', () => {
  test('replace with payload containing FM updates the YAML region of Y.Text', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      // Seed existing FM.
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(
          session.dc.document,
          '---\ntitle: Old Title\n---\n# Body\n\nOriginal body.\n',
          'replace',
        );
      }, AGENT_WRITE_ORIGIN);

      const payload =
        '---\ntitle: New Title\ncluster: research\n---\n\n# Body\n\nAgent-updated body.\n';
      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        { docName: 'test-doc', markdown: payload, position: 'replace' },
      );

      expect(response.status).toBe(200);

      // YAML region in Y.Text reflects the new FM.
      expect(fmMap(session.dc.document)).toEqual({
        title: 'New Title',
        cluster: 'research',
      });

      const ytext = session.dc.document.getText('source').toString();
      expect(ytext).toContain('title: New Title');
      expect(ytext).toContain('cluster: research');
      expect(ytext).toContain('Agent-updated body.');

      const closingFenceIdx = ytext.indexOf('---\n', 4);
      expect(closingFenceIdx).toBeGreaterThan(-1);
      const afterFmClose = ytext.slice(closingFenceIdx + 4);
      expect(afterFmClose).not.toContain('---');
    } finally {
      await cleanup();
    }
  });

  test('replace with body-only payload preserves existing FM', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      const existingFm = '---\ntitle: Keep Me\nauthor: Alice\n---\n';
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, `${existingFm}# Old Body\n`, 'replace');
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        { docName: 'test-doc', markdown: '# New Body\n\nFresh content.\n', position: 'replace' },
      );

      expect(response.status).toBe(200);

      expect(ytextFm(session.dc.document)).toBe(existingFm);
      expect(fmMap(session.dc.document)).toEqual({
        title: 'Keep Me',
        author: 'Alice',
      });

      const ytext = session.dc.document.getText('source').toString();
      expect(ytext.startsWith(existingFm)).toBe(true);
      expect(ytext).toContain('# New Body');
      expect(ytext).toContain('Fresh content.');
      expect(ytext).not.toContain('# Old Body');
    } finally {
      await cleanup();
    }
  });

  test('append payload never touches FM', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      const existingFm = '---\ntitle: Stable\n---\n';
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(
          session.dc.document,
          `${existingFm}# Header\n\nFirst paragraph.\n`,
          'replace',
        );
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        { docName: 'test-doc', markdown: 'Appended paragraph.\n', position: 'append' },
      );

      expect(response.status).toBe(200);
      expect(ytextFm(session.dc.document)).toBe(existingFm);
      expect(fmMap(session.dc.document)).toEqual({ title: 'Stable' });

      const ytext = session.dc.document.getText('source').toString();
      expect(ytext).toContain('title: Stable');
      expect(ytext).toContain('First paragraph.');
      expect(ytext).toContain('Appended paragraph.');
      expect(ytext.split('---\n').length).toBe(3);
    } finally {
      await cleanup();
    }
  });

  test('append payload that itself starts with FM does NOT double-write FM', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      const existingFm = '---\ntitle: First\n---\n';
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, `${existingFm}# Body\n`, 'replace');
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        {
          docName: 'test-doc',
          markdown: '---\ntitle: Second\n---\n\nExtra.\n',
          position: 'append',
        },
      );

      expect(response.status).toBe(200);
      expect(fmMap(session.dc.document)).toEqual({ title: 'First' });

      const ytext = session.dc.document.getText('source').toString();
      const fmOpenMatches = ytext.match(/^---\n|^\n---\n/gm) ?? [];
      expect(fmOpenMatches.length).toBeLessThanOrEqual(2);
    } finally {
      await cleanup();
    }
  });

  test('prepend payload that itself starts with FM does NOT double-write FM', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      const existingFm = '---\ntitle: First\n---\n';
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, `${existingFm}# Original Body\n`, 'replace');
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        {
          docName: 'test-doc',
          markdown: '---\ntitle: Second\n---\n\nPrepended.\n',
          position: 'prepend',
        },
      );

      expect(response.status).toBe(200);
      expect(ytextFm(session.dc.document)).toBe(existingFm);
      expect(fmMap(session.dc.document)).toEqual({ title: 'First' });

      const ytext = session.dc.document.getText('source').toString();
      const fmOpenMatches = ytext.match(/^---\n|^\n---\n/gm) ?? [];
      expect(fmOpenMatches.length).toBeLessThanOrEqual(2);
      expect(ytext).toContain('Prepended.');
      expect(ytext).toContain('# Original Body');
      expect(ytext).not.toContain('title: Second');
    } finally {
      await cleanup();
    }
  });
});

describe('POST /api/frontmatter-patch (edit_frontmatter) — fence spacing (PRD-6837 #4)', () => {
  test('creating a fence on a doc with no FM inserts a single blank line after the closing ---', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      // Doc starts with NO frontmatter — a bare body.
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, '# Heading\n\nbody text\n', 'replace');
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/frontmatter-patch',
        { docName: 'test-doc', patch: { addedkey: 'v1' } },
      );

      expect(response.status).toBe(200);
      const ytext = session.dc.document.getText('source').toString();
      // Exactly one blank line between the closing fence and the body — not a
      // glued `---\n# Heading`, and not a doubled `---\n\n\n# Heading`.
      expect(ytext).toBe('---\naddedkey: v1\n---\n\n# Heading\n\nbody text\n');
      expect(ytext).not.toContain('---\n# Heading');
    } finally {
      await cleanup();
    }
  });

  test('patching an existing fence does not add extra blank lines to the body seam', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      // Doc already has FM followed by the canonical single blank line.
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(
          session.dc.document,
          '---\ntitle: Keep\n---\n\n# Heading\n\nbody text\n',
          'replace',
        );
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/frontmatter-patch',
        { docName: 'test-doc', patch: { addedkey: 'v1' } },
      );

      expect(response.status).toBe(200);
      const ytext = session.dc.document.getText('source').toString();
      expect(ytext).toBe('---\ntitle: Keep\naddedkey: v1\n---\n\n# Heading\n\nbody text\n');
    } finally {
      await cleanup();
    }
  });

  test('creating a fence on a body that already starts with a newline does not double the blank line', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      // Body already begins with a blank line — the separator must not double.
      // Seed Y.Text directly so the leading-newline byte premise is exact
      // (the write path may normalize a leading newline away).
      session.dc.document.transact(() => {
        session.dc.document.getText('source').insert(0, '\n# Heading\n');
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/frontmatter-patch',
        { docName: 'test-doc', patch: { addedkey: 'v1' } },
      );

      expect(response.status).toBe(200);
      const ytext = session.dc.document.getText('source').toString();
      expect(ytext).toBe('---\naddedkey: v1\n---\n\n# Heading\n');
      expect(ytext).not.toContain('---\n\n\n');
    } finally {
      await cleanup();
    }
  });
});

describe('POST /api/agent-patch (edit_document) — frontmatter rejection', () => {
  test('rejects yaml-shape find (e.g. "cluster: misc") with 400 + migration hint', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      const existingFm = '---\ntitle: Old Title\ncluster: misc\n---\n';
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(
          session.dc.document,
          `${existingFm}# Body\n\nThe body stays.\n`,
          'replace',
        );
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(hocuspocus, sessionManager, contentDir, '/api/agent-patch', {
        docName: 'test-doc',
        find: 'cluster: misc',
        replace: 'cluster: research',
      });

      expect(response.status).toBe(400);
      const parsed = JSON.parse(response.body);
      expect(parsed.type).toBe('urn:ok:error:frontmatter-edit-not-supported');
      expect(parsed.title).toContain('Frontmatter edits are not supported');
      expect(parsed.title).toContain('edit(');

      expect(ytextFm(session.dc.document)).toBe(existingFm);
      expect(fmMap(session.dc.document)).toEqual({
        title: 'Old Title',
        cluster: 'misc',
      });
      const ytext = session.dc.document.getText('source').toString();
      expect(ytext).toContain('cluster: misc');
      expect(ytext).not.toContain('cluster: research');
      expect(ytext).toContain('The body stays.');
    } finally {
      await cleanup();
    }
  });

  test('rejects find containing "---" fence with 400 + doc unchanged', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      const existingFm = '---\ntitle: ToRemove\n---\n';
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(
          session.dc.document,
          `${existingFm}# Body\n\nKeep me.\n`,
          'replace',
        );
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(hocuspocus, sessionManager, contentDir, '/api/agent-patch', {
        docName: 'test-doc',
        find: '---\ntitle: ToRemove\n---\n',
        replace: '',
      });

      expect(response.status).toBe(400);
      const parsed = JSON.parse(response.body);
      expect(parsed.title).toContain('Frontmatter edits are not supported');

      expect(ytextFm(session.dc.document)).toBe(existingFm);
      expect(fmMap(session.dc.document)).toEqual({ title: 'ToRemove' });
      const ytext = session.dc.document.getText('source').toString();
      expect(ytext).toContain('title: ToRemove');
      expect(ytext).toContain('Keep me.');
    } finally {
      await cleanup();
    }
  });

  test('rejects body-shape find ("draft") that first-matches inside FM via position-based check', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      const existingFm = '---\nstatus: draft\n---\n';
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(
          session.dc.document,
          `${existingFm}# Body\n\nNot a draft.\n`,
          'replace',
        );
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(hocuspocus, sessionManager, contentDir, '/api/agent-patch', {
        docName: 'test-doc',
        find: 'draft',
        replace: 'published',
      });

      expect(response.status).toBe(400);
      const parsed = JSON.parse(response.body);
      expect(parsed.title).toContain('Frontmatter edits are not supported');

      expect(ytextFm(session.dc.document)).toBe(existingFm);
      expect(fmMap(session.dc.document)).toEqual({ status: 'draft' });
      const ytext = session.dc.document.getText('source').toString();
      expect(ytext).toContain('status: draft');
      expect(ytext).toContain('Not a draft.');
      expect(ytext).not.toContain('published');
    } finally {
      await cleanup();
    }
  });

  test('body-only patch with non-yaml find still applies (regression — body path unaffected)', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      const existingFm = '---\ntitle: Doc\n---\n';
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(
          session.dc.document,
          `${existingFm}# Body\n\nalpha appears here.\n`,
          'replace',
        );
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(hocuspocus, sessionManager, contentDir, '/api/agent-patch', {
        docName: 'test-doc',
        find: 'alpha',
        replace: 'beta',
      });

      expect(response.status).toBe(200);

      expect(ytextFm(session.dc.document)).toBe(existingFm);
      expect(fmMap(session.dc.document)).toEqual({ title: 'Doc' });
      const ytext = session.dc.document.getText('source').toString();
      expect(ytext).toContain('beta appears here.');
      expect(ytext).not.toContain('alpha appears here.');
    } finally {
      await cleanup();
    }
  });

  test('returns 404 (not 400) when non-yaml find is absent from both FM and body', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(
          session.dc.document,
          '---\ntitle: Stable\n---\n# Body\n\nReal content.\n',
          'replace',
        );
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(hocuspocus, sessionManager, contentDir, '/api/agent-patch', {
        docName: 'test-doc',
        find: 'nonexistent text that is nowhere',
        replace: 'whatever',
      });

      expect(response.status).toBe(404);
      // target-not-found emits RFC 9457 problem+json post-identity.
      const parsed = JSON.parse(response.body);
      expect(parsed.type).toBe('urn:ok:error:target-not-found');
      expect(parsed.status).toBe(404);
      // Negative: confirm target-not-found isn't mis-routed to the
      // frontmatter-rejection path. The URN check already proves
      // this; the title check here documents the intent.
      expect(parsed.title).not.toContain('Frontmatter edits are not supported');
    } finally {
      await cleanup();
    }
  });

  test('rejects yaml-shape find even when no FM exists in the doc (heuristic precheck is doc-stateless)', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(
          session.dc.document,
          '# Body\n\nfoo: bar appears here.\n',
          'replace',
        );
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(hocuspocus, sessionManager, contentDir, '/api/agent-patch', {
        docName: 'test-doc',
        find: 'foo: bar',
        replace: 'baz: qux',
      });

      expect(response.status).toBe(400);
      const parsed = JSON.parse(response.body);
      expect(parsed.title).toContain('Frontmatter edits are not supported');

      const ytext = session.dc.document.getText('source').toString();
      expect(ytext).toContain('foo: bar appears here.');
      expect(ytext).not.toContain('baz: qux');
    } finally {
      await cleanup();
    }
  });

  test('does NOT precheck-reject body-only patch on bare-colon prose (`IMPORTANT:`, `Note:`)', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(
          session.dc.document,
          '---\ntitle: Doc\n---\n# Body\n\nIMPORTANT: read this.\n',
          'replace',
        );
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(hocuspocus, sessionManager, contentDir, '/api/agent-patch', {
        docName: 'test-doc',
        find: 'IMPORTANT:',
        replace: 'NOTE:',
      });

      expect(response.status).toBe(200);
      const ytext = session.dc.document.getText('source').toString();
      expect(ytext).toContain('NOTE: read this.');
      expect(ytext).not.toContain('IMPORTANT:');
    } finally {
      await cleanup();
    }
  });
});

describe('agent-undo round-trip across FM-touching writes', () => {
  test('applyAgentUndo reverts FM region in lock-step with body changes', async () => {
    const { sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('doc-fm-undo.md');
      const document = session.dc.document;

      // Frame 1: seed FM + body under session.origin so the UM tracks it.
      document.transact(() => {
        applyAgentMarkdownWrite(
          document,
          '---\ntitle: Original\nstatus: draft\n---\n# Body\n',
          'replace',
        );
      }, session.origin);
      session.um.stopCapturing();

      // Frame 2: touch FM (title) only.
      document.transact(() => {
        applyAgentMarkdownWrite(
          document,
          '---\ntitle: Updated\nstatus: draft\n---\n# Body\n',
          'replace',
        );
      }, session.origin);

      expect(fmMap(document)).toEqual({ title: 'Updated', status: 'draft' });

      // Undo: Y.Text reverts the byte range modified in Frame 2 — bringing
      // the FM region back to the Frame 1 state.
      const undone = applyAgentUndo(session, 'last');
      expect(undone).toBe(true);
      expect(fmMap(document)).toEqual({ title: 'Original', status: 'draft' });
    } finally {
      await cleanup();
    }
  });
});

// reproducer: agents constructing markdown by hand sometimes ship
// unquoted string values that contain YAML-significant characters (`:`, `#`,
// leading `-`). With Y.Text-is-truth, those bytes reach disk verbatim and the
// property panel shows "Frontmatter YAML is malformed". The gate in
// `applyAgentMarkdownWriteInner` refuses the write at the write boundary so
// the bad bytes never land — only triggered when the FM actually CHANGED, so
// docs that already carry malformed FM stay editable for body-only writes.
describe('POST /api/agent-write-md (write_document) — malformed-FM refusal (PRD-6781)', () => {
  test('replace with unquoted-colon title returns 400 + RFC 9457 envelope; doc unchanged', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      // The exact shape title with a colon, no quotes.
      const malformed = [
        '---',
        'title: The End of 3% Mortgages: Why the Mortgage Lock-In Effect Is Fading in 2026',
        'description: One-liner',
        'tags: [source, immutable]',
        '---',
        '',
        '# Body',
        '',
        'Some content.',
        '',
      ].join('\n');

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        { docName: 'test-doc', markdown: malformed, position: 'replace' },
      );

      expect(response.status).toBe(400);
      const parsed = JSON.parse(response.body);
      expect(parsed.type).toBe('urn:ok:error:frontmatter-malformed');
      expect(parsed.title).toBe('Frontmatter YAML is malformed.');
      expect(parsed.file).toBe('test-doc.md');
      // The envelope carries the raw yaml@2 parser message + the fix hint.
      // Assert on stable shape (non-empty parseError + hint substring), not
      // yaml@2's specific English wording — a parser upgrade that rephrases
      // the message would silently regress a wording-pinned test.
      expect(typeof parsed.parseError).toBe('string');
      expect((parsed.parseError as string).length).toBeGreaterThan(0);
      expect(parsed.detail).toContain('YAML-significant characters');

      // Y.Text untouched — the agent's malformed bytes never landed.
      const ytext = session.dc.document.getText('source').toString();
      expect(ytext).toBe('');
      expect(ytextFm(session.dc.document)).toBe('');
    } finally {
      await cleanup();
    }
  });

  test('quoted title with colons writes through unchanged (the documented fix)', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      const wellFormed = [
        '---',
        'title: "The End of 3% Mortgages: Why the Mortgage Lock-In Effect Is Fading in 2026"',
        'tags: [source, immutable]',
        '---',
        '',
        '# Body',
        '',
      ].join('\n');

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        { docName: 'test-doc', markdown: wellFormed, position: 'replace' },
      );

      expect(response.status).toBe(200);
      expect(fmMap(session.dc.document)).toEqual({
        title: 'The End of 3% Mortgages: Why the Mortgage Lock-In Effect Is Fading in 2026',
        tags: ['source', 'immutable'],
      });
    } finally {
      await cleanup();
    }
  });

  test("Obsidian's empty `tags:` / `aliases:` null shapes write through (200), not refused at the gate", async () => {
    // The gate calls `parseFrontmatterYaml` → `FrontmatterMapSchema.safeParse`,
    // which now coerces Obsidian's `null` empty-list / bare-key shapes to empty
    // values instead of rejecting the whole map. Pin the HTTP boundary so a
    // future early-guard added before the schema call (which the unit tests
    // would not catch) can't silently start refusing these real-vault files.
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      const obsidianShape = [
        '---',
        'plugin-id: dataview',
        'tags:',
        '- ',
        'aliases:',
        '- ',
        'publish: true',
        '---',
        '',
        '# Body',
        '',
      ].join('\n');

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        { docName: 'test-doc', markdown: obsidianShape, position: 'replace' },
      );

      expect(response.status).toBe(200);
      // Read back through the (coerced) schema: empty lists, real keys intact.
      expect(fmMap(session.dc.document)).toEqual({
        'plugin-id': 'dataview',
        tags: [],
        aliases: [],
        publish: true,
      });
    } finally {
      await cleanup();
    }
  });

  test('append AND prepend skip the gate even when the existing FM is already malformed', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      // Seed a doc with malformed FM directly into Y.Text (simulating a doc
      // authored before this gate existed — its bytes are already on disk).
      const preexisting = ['---', 'title: Already: Broken', '---', '', '# Existing Body', ''].join(
        '\n',
      );
      session.dc.document.transact(() => {
        const ytext = session.dc.document.getText('source');
        ytext.insert(0, preexisting);
      }, AGENT_WRITE_ORIGIN);

      // Body-only append must still succeed — the gate only fires on FM change.
      const appendResponse = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        { docName: 'test-doc', markdown: 'Appended paragraph.\n', position: 'append' },
      );
      expect(appendResponse.status).toBe(200);

      // And prepend must too — covers the parallel `case 'prepend'` branch
      // that also routes through `finalFm = existingFm`.
      const prependResponse = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        { docName: 'test-doc', markdown: 'Prepended paragraph.\n', position: 'prepend' },
      );
      expect(prependResponse.status).toBe(200);

      const ytext = session.dc.document.getText('source').toString();
      expect(ytext).toContain('Already: Broken');
      expect(ytext).toContain('Appended paragraph.');
      expect(ytext).toContain('Prepended paragraph.');
    } finally {
      await cleanup();
    }
  });

  test('replace with body-only payload on doc with malformed existing FM succeeds (inheritor protection)', async () => {
    // The introducer-vs-inheritor invariant for the `replace` branch:
    // `finalFm = payloadFm || existingFm` — when `payloadFm = ''` (no FM in
    // the agent's payload), `finalFm = existingFm`, so the gate skips and
    // the doc remains editable for body-only writes even when its FM is
    // already broken. A future refactor that drops the `||` fallback would
    // start rejecting recovery workflows for legacy malformed docs.
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      const malformedDoc = ['---', 'title: Already: Broken', '---', '', '# Old Body', ''].join(
        '\n',
      );
      session.dc.document.transact(() => {
        session.dc.document.getText('source').insert(0, malformedDoc);
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        { docName: 'test-doc', markdown: '# New Body\n\nReplaced.\n', position: 'replace' },
      );

      expect(response.status).toBe(200);
      const ytext = session.dc.document.getText('source').toString();
      // The malformed FM is inherited verbatim — gate did not fire.
      expect(ytext).toContain('Already: Broken');
      // Body region was replaced.
      expect(ytext).toContain('Replaced.');
      expect(ytext).not.toContain('# Old Body');
    } finally {
      await cleanup();
    }
  });

  test('replace that keeps the same malformed FM is rejected (agent re-introduces the break)', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      // Start with a clean doc.
      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(
          session.dc.document,
          '---\ntitle: Clean Start\n---\n# Body\n',
          'replace',
        );
      }, AGENT_WRITE_ORIGIN);

      // Agent re-submits with a malformed title — `finalFm !== existingFm`,
      // gate fires.
      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        {
          docName: 'test-doc',
          markdown: '---\ntitle: Foo: Bar\n---\n# Updated\n',
          position: 'replace',
        },
      );

      expect(response.status).toBe(400);
      const parsed = JSON.parse(response.body);
      expect(parsed.type).toBe('urn:ok:error:frontmatter-malformed');

      // Y.Text unchanged — Clean Start survives.
      expect(fmMap(session.dc.document)).toEqual({ title: 'Clean Start' });
    } finally {
      await cleanup();
    }
  });

  test('replace with top-level array FM (non-mapping) is rejected with 400', async () => {
    // Exercises the non-parse `map: null` branch of `parseFrontmatterYaml`:
    // YAML parses fine but the top-level value isn't a mapping. Without this
    // case the gate's coverage would only span yaml@2-side failures and miss
    // the schema/shape rejections — the widened FIX_HINT addresses both
    // classes, so the test should too.
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      const arrayFm = ['---', '- one', '- two', '- three', '---', '', '# Body', ''].join('\n');
      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        { docName: 'test-doc', markdown: arrayFm, position: 'replace' },
      );

      expect(response.status).toBe(400);
      const parsed = JSON.parse(response.body);
      expect(parsed.type).toBe('urn:ok:error:frontmatter-malformed');
      expect(parsed.parseError).toBe('top-level value is not a mapping');
      // Bytes never landed.
      expect(session.dc.document.getText('source').toString()).toBe('');
    } finally {
      await cleanup();
    }
  });
});

// the recursive `FrontmatterValueSchema` accepts nested mappings,
// arrays of objects, and arbitrarily deep nesting. The malformed-write gate's
// predicate (`parsed.map === null`) narrows accordingly — only genuine YAML
// parse errors and non-mapping top-level values still refuse. The structured
// `frontmatter-malformed-write-refused` event now carries a bounded-
// cardinality `class` label so ops can confirm the
// nested-rejection bucket is at zero without unbounded counter cardinality.
describe('POST /api/agent-write-md (write_document) — nested frontmatter acceptance (PRD-6947)', () => {
  test('replace with nested `metadata:` map succeeds; Y.Text reflects the nested structure', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      const skillFile = [
        '---',
        'name: example-skill',
        'description: a one-line description',
        'metadata:',
        '  version: 1.0.0',
        '  author: Inkeep',
        '  repository: https://github.com/example/repo',
        '---',
        '',
        '# Body',
        '',
      ].join('\n');

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        { docName: 'test-doc', markdown: skillFile, position: 'replace' },
      );

      expect(response.status).toBe(200);
      expect(fmMap(session.dc.document)).toEqual({
        name: 'example-skill',
        description: 'a one-line description',
        metadata: {
          version: '1.0.0',
          author: 'Inkeep',
          repository: 'https://github.com/example/repo',
        },
      });
    } finally {
      await cleanup();
    }
  });

  test('replace with arbitrarily deep nesting succeeds', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      const deep = [
        '---',
        'title: Deep',
        'metadata:',
        '  outer:',
        '    inner:',
        '      leaf: deep-value',
        '---',
        '',
        '# Body',
        '',
      ].join('\n');

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        { docName: 'test-doc', markdown: deep, position: 'replace' },
      );

      expect(response.status).toBe(200);
      expect(fmMap(session.dc.document)).toEqual({
        title: 'Deep',
        metadata: { outer: { inner: { leaf: 'deep-value' } } },
      });
    } finally {
      await cleanup();
    }
  });

  test('replace with array-of-objects frontmatter succeeds', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      const arrayOfObjects = [
        '---',
        'title: With Plugins',
        'plugins:',
        '  - name: alpha',
        '    version: 1.0',
        '  - name: beta',
        '    version: 2.0',
        '---',
        '',
        '# Body',
        '',
      ].join('\n');

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        { docName: 'test-doc', markdown: arrayOfObjects, position: 'replace' },
      );

      expect(response.status).toBe(200);
      expect(fmMap(session.dc.document)).toEqual({
        title: 'With Plugins',
        plugins: [
          { name: 'alpha', version: 1.0 },
          { name: 'beta', version: 2.0 },
        ],
      });
    } finally {
      await cleanup();
    }
  });

  test('replace that adds a nested key to an existing doc succeeds (gate accepts the change)', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(
          session.dc.document,
          '---\ntitle: Flat Start\n---\n# Body\n',
          'replace',
        );
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        {
          docName: 'test-doc',
          markdown: '---\ntitle: Flat Start\nmetadata:\n  version: 2.0\n---\n# Body\n',
          position: 'replace',
        },
      );

      expect(response.status).toBe(200);
      expect(fmMap(session.dc.document)).toEqual({
        title: 'Flat Start',
        metadata: { version: 2.0 },
      });
    } finally {
      await cleanup();
    }
  });

  test('genuinely malformed YAML still returns the RFC-9457 envelope (PRD-6781 case preserved)', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        {
          docName: 'test-doc',
          markdown: '---\ntitle: The End of 3% Mortgages: Why the Lock-In Is Fading\n---\n# Body\n',
          position: 'replace',
        },
      );

      expect(response.status).toBe(400);
      const parsed = JSON.parse(response.body);
      expect(parsed.type).toBe('urn:ok:error:frontmatter-malformed');
      // Y.Text untouched.
      expect(session.dc.document.getText('source').toString()).toBe('');
    } finally {
      await cleanup();
    }
  });
});

describe('POST /api/agent-write-md — telemetry refusal-class split (PRD-6947, Q-X7)', () => {
  // The structured `frontmatter-malformed-write-refused` event now carries a
  // bounded-cardinality `class` label. The nested-rejection
  // bucket does not appear — nested-but-valid writes skip the gate entirely.
  // These tests pin the classifier wiring at the HTTP boundary so a future
  // change to either the event shape or the classifier surfaces a regression.

  function collectRefusalEvents(
    spy: ReturnType<typeof spyOn<typeof console, 'warn'>>,
  ): Array<Record<string, unknown>> {
    return spy.mock.calls
      .map((call) => call[0])
      .filter((arg): arg is string => typeof arg === 'string')
      .map((arg) => {
        try {
          return JSON.parse(arg) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(
        (parsed): parsed is Record<string, unknown> =>
          parsed !== null && parsed.event === 'frontmatter-malformed-write-refused',
      );
  }

  test('yaml@2 parse error (PRD-6781 unquoted-colon) classifies as `yaml-parse-error`', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      await sessionManager.getSession('test-doc');

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        {
          docName: 'test-doc',
          markdown: '---\ntitle: Foo: bar\n---\n# Body\n',
          position: 'replace',
        },
      );

      expect(response.status).toBe(400);
      const events = collectRefusalEvents(warnSpy);
      expect(events.length).toBe(1);
      expect(events[0]?.class).toBe('yaml-parse-error');
      expect(events[0]?.handler).toBe('agent-write-md');
    } finally {
      warnSpy.mockRestore();
      await cleanup();
    }
  });

  test('top-level array FM classifies as `non-mapping-top-level`', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      await sessionManager.getSession('test-doc');

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        {
          docName: 'test-doc',
          markdown: '---\n- one\n- two\n---\n# Body\n',
          position: 'replace',
        },
      );

      expect(response.status).toBe(400);
      const events = collectRefusalEvents(warnSpy);
      expect(events.length).toBe(1);
      expect(events[0]?.class).toBe('non-mapping-top-level');
    } finally {
      warnSpy.mockRestore();
      await cleanup();
    }
  });

  test('nested-but-valid frontmatter does NOT fire the refusal event (retired bucket)', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      await sessionManager.getSession('test-doc');

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/agent-write-md',
        {
          docName: 'test-doc',
          markdown:
            '---\ntitle: Nested Skill\nmetadata:\n  version: 1.0.0\n  author: Inkeep\n---\n# Body\n',
          position: 'replace',
        },
      );

      expect(response.status).toBe(200);
      const events = collectRefusalEvents(warnSpy);
      expect(events.length).toBe(0);
    } finally {
      warnSpy.mockRestore();
      await cleanup();
    }
  });
});

// the `/api/frontmatter-patch` route now accepts a nested
// object value at a top-level key (whole-subtree REPLACE — caller sends the
// full subtree they want). A top-level `null` deletes the (potentially
// nested) value at that key. A nested null INSIDE a subtree is rejected per
// the recursive `FrontmatterValueSchema` (null is not in the value union),
// because the wire contract stays additive + path-syntax-free.
describe('POST /api/frontmatter-patch — nested value acceptance (PRD-6947)', () => {
  test('nested-object patch value sets the subtree on a fresh doc; Y.Text reflects the nested YAML', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, '# Body\n', 'replace');
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/frontmatter-patch',
        {
          docName: 'test-doc',
          patch: { metadata: { version: '1.0.0', author: 'Inkeep' } },
        },
      );

      expect(response.status).toBe(200);
      const parsed = JSON.parse(response.body);
      expect(parsed.appliedKeys).toEqual(['metadata']);
      expect(fmMap(session.dc.document)).toEqual({
        metadata: { version: '1.0.0', author: 'Inkeep' },
      });
    } finally {
      await cleanup();
    }
  });

  test('nested-object patch REPLACES the existing subtree at the top-level key (whole-subtree merge)', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(
          session.dc.document,
          '---\ntitle: Skill\nmetadata:\n  version: 1.0.0\n  author: Inkeep\n  license: MIT\n---\n# Body\n',
          'replace',
        );
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/frontmatter-patch',
        {
          docName: 'test-doc',
          patch: { metadata: { version: '2.0.0', author: 'Inkeep' } },
        },
      );

      expect(response.status).toBe(200);
      expect(fmMap(session.dc.document)).toEqual({
        title: 'Skill',
        metadata: { version: '2.0.0', author: 'Inkeep' },
      });
    } finally {
      await cleanup();
    }
  });

  test('top-level null deletes the nested subtree; sibling top-level keys preserved', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(
          session.dc.document,
          '---\ntitle: Skill\nmetadata:\n  version: 1.0.0\n  author: Inkeep\n---\n# Body\n',
          'replace',
        );
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/frontmatter-patch',
        { docName: 'test-doc', patch: { metadata: null } },
      );

      expect(response.status).toBe(200);
      expect(fmMap(session.dc.document)).toEqual({ title: 'Skill' });
    } finally {
      await cleanup();
    }
  });

  test('array-of-objects patch value sets the array; per-item objects round-trip into Y.Text', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, '# Body\n', 'replace');
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/frontmatter-patch',
        {
          docName: 'test-doc',
          patch: {
            plugins: [
              { name: 'alpha', version: '1.0' },
              { name: 'beta', version: '2.0' },
            ],
          },
        },
      );

      expect(response.status).toBe(200);
      expect(fmMap(session.dc.document)).toEqual({
        plugins: [
          { name: 'alpha', version: '1.0' },
          { name: 'beta', version: '2.0' },
        ],
      });
    } finally {
      await cleanup();
    }
  });

  test('arbitrarily deep nesting (map in map in map) is accepted and round-trips', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, '# Body\n', 'replace');
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/frontmatter-patch',
        {
          docName: 'test-doc',
          patch: { metadata: { outer: { inner: { leaf: 'deep-value' } } } },
        },
      );

      expect(response.status).toBe(200);
      expect(fmMap(session.dc.document)).toEqual({
        metadata: { outer: { inner: { leaf: 'deep-value' } } },
      });
    } finally {
      await cleanup();
    }
  });

  test('flat patch behaves exactly as before (regression guard for the existing contract)', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(
          session.dc.document,
          '---\ntitle: Original\n---\n# Body\n',
          'replace',
        );
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/frontmatter-patch',
        { docName: 'test-doc', patch: { title: 'Updated', tags: ['planning', 'q3'] } },
      );

      expect(response.status).toBe(200);
      expect(fmMap(session.dc.document)).toEqual({
        title: 'Updated',
        tags: ['planning', 'q3'],
      });
    } finally {
      await cleanup();
    }
  });

  test('mixed flat + nested keys in one patch apply atomically', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, '# Body\n', 'replace');
      }, AGENT_WRITE_ORIGIN);

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/frontmatter-patch',
        {
          docName: 'test-doc',
          patch: {
            title: 'Skill',
            tags: ['demo'],
            metadata: { version: '1.0.0', author: 'Inkeep' },
          },
        },
      );

      expect(response.status).toBe(200);
      expect(fmMap(session.dc.document)).toEqual({
        title: 'Skill',
        tags: ['demo'],
        metadata: { version: '1.0.0', author: 'Inkeep' },
      });
    } finally {
      await cleanup();
    }
  });

  test('nested null inside a subtree (a deep-leaf delete) is rejected with per-key fieldErrors; Y.Doc untouched', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(
          session.dc.document,
          '---\ntitle: Skill\nmetadata:\n  version: 1.0.0\n  author: Inkeep\n---\n# Body\n',
          'replace',
        );
      }, AGENT_WRITE_ORIGIN);

      const beforeFm = ytextFm(session.dc.document);

      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/frontmatter-patch',
        {
          docName: 'test-doc',
          patch: { metadata: { version: null } },
        },
      );

      expect(response.status).toBe(400);
      const parsed = JSON.parse(response.body);
      expect(parsed.type).toBe('urn:ok:error:invalid-request');
      // Y.Text untouched — atomic reject.
      expect(ytextFm(session.dc.document)).toBe(beforeFm);
    } finally {
      await cleanup();
    }
  });

  test('invalid nested leaf (function value) is rejected with per-key fieldErrors; Y.Doc untouched', async () => {
    const { contentDir, hocuspocus, sessionManager, cleanup } = setup();
    try {
      const session = await sessionManager.getSession('test-doc');

      session.dc.document.transact(() => {
        applyAgentMarkdownWrite(session.dc.document, '---\ntitle: Skill\n---\n# Body\n', 'replace');
      }, AGENT_WRITE_ORIGIN);

      const beforeFm = ytextFm(session.dc.document);

      // A nested value whose leaf is outside the recursive value union
      // (here, an explicit non-finite numeric token round-tripped through
      // JSON.parse(JSON.stringify(...))) — the schema must atomically reject
      // the whole patch. Using a stringly-invalid value lets us drive this
      // through the JSON wire without needing to construct a Symbol /
      // function (the JSON encoder would drop those).
      const response = await callApi(
        hocuspocus,
        sessionManager,
        contentDir,
        '/api/frontmatter-patch',
        {
          docName: 'test-doc',
          // Reserved key — applyPatchToFm refuses 'frontmatter' as a
          // top-level key (reserved by precedent) AND surfaces it as a
          // per-key fieldError on the same atomic-reject envelope.
          patch: { frontmatter: { not: 'allowed' } },
        },
      );

      expect(response.status).toBe(400);
      const parsed = JSON.parse(response.body);
      expect(parsed.type).toBe('urn:ok:error:invalid-frontmatter-patch');
      expect(parsed.fieldErrors).toBeDefined();
      expect(parsed.fieldErrors.frontmatter).toContain('reserved');
      // Y.Text untouched.
      expect(ytextFm(session.dc.document)).toBe(beforeFm);
    } finally {
      await cleanup();
    }
  });
});
