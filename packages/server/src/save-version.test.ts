/**
 * Save-version integration tests.
 *
 * Verifies the shadow-only contract:
 *   - History checkpoint ALWAYS lands (plumbing path, no hooks/signing).
 *   - The user's parent git repo is never mutated.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import simpleGit from 'simple-git';
import * as Y from 'yjs';
import { AgentSessionManager } from './agent-sessions.ts';
import { createApiExtension } from './api-extension.ts';
import {
  commitWip,
  initShadowRepo,
  type ShadowHandle,
  type ShadowRef,
  shadowGit,
  type WriterIdentity,
} from './shadow-repo.ts';

interface CapturedResponse {
  status: number;
  body: string;
  parsed: Record<string, unknown>;
}

function makeJsonPostReq(url: string, body: unknown): IncomingMessage {
  const readable = Readable.from(Buffer.from(JSON.stringify(body))) as unknown as IncomingMessage;
  readable.method = 'POST';
  readable.url = url;
  readable.headers = { host: 'localhost', 'content-type': 'application/json' };
  return readable;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: '', parsed: {} };
  const res = {
    writeHead(status: number) {
      captured.status = status;
    },
    setHeader() {},
    end(body?: string) {
      captured.body = body ?? '';
      try {
        captured.parsed = JSON.parse(body ?? '{}') as Record<string, unknown>;
      } catch {
        // non-JSON body
      }
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

describe('save-version shadow checkpoint', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-sv-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('non-git dir: history checkpoint lands', async () => {
    const contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(join(contentDir, 'doc.md'), '# Hello\n');

    const historyHandle = await initShadowRepo(tmpDir);
    const shadowRef: ShadowRef = { current: historyHandle };

    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus);

    try {
      const ext = createApiExtension({
        hocuspocus,
        sessionManager,
        contentDir,
        projectDir: tmpDir, // tmpDir is NOT a git repo
        shadowRef,
        contentRoot: 'content',
        getFileIndex: () => new Map(),
      });

      const req = makeJsonPostReq('/api/save-version', { message: 'first checkpoint' });
      const { res, captured } = makeRes();
      await (
        ext as {
          onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
        }
      ).onRequest({ request: req, response: res });

      expect(captured.status).toBe(200);
      expect(typeof captured.parsed.checkpointRef).toBe('string');
    } finally {
      await sessionManager.closeAll();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RED tests — the new contract: server MUST NOT mutate the user's
// real git history (HEAD, tags, index) on save-version or rollback. Shadow
// checkpoint still lands; only the parent-git wrapping is forbidden.
// ─────────────────────────────────────────────────────────────────────────────

describe('PRD-6716: save-version + rollback do not mutate parent git', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-prd-6716-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('git dir: parent-git is NOT mutated — checkpoint stays shadow-only (PRD-6716)', async () => {
    const projectDir = tmpDir;
    const contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(join(contentDir, 'doc.md'), '# Hello\n');

    const git = simpleGit(projectDir);
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');
    writeFileSync(join(projectDir, 'README.md'), '# project\n');
    await git.add('.');
    await git.commit('initial');

    const historyHandle = await initShadowRepo(projectDir);
    const shadowRef: ShadowRef = { current: historyHandle };

    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus);

    const headBefore = (await git.raw(['rev-parse', 'HEAD'])).trim();
    const tagsBefore = (await git.tags(['--list', 'ok/v*'])).all;
    const statusBefore = (await git.raw(['status', '--porcelain'])).trim();

    try {
      const ext = createApiExtension({
        hocuspocus,
        sessionManager,
        contentDir,
        projectDir,
        shadowRef,
        contentRoot: 'content',
        getFileIndex: () => new Map(),
      });

      const req = makeJsonPostReq('/api/save-version', {});
      const { res, captured } = makeRes();
      await (
        ext as {
          onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
        }
      ).onRequest({ request: req, response: res });

      expect(captured.status).toBe(200);
      // Shadow checkpoint still lands (wanted half of the contract).
      expect(typeof captured.parsed.checkpointRef).toBe('string');
      expect((captured.parsed.checkpointRef as string).length).toBeGreaterThan(0);
      // versionTag is no longer in the response (parent-git tag never created).
      expect(captured.parsed.versionTag).toBeUndefined();

      // RED contract: user's git HEAD, tags, index all unchanged.
      const headAfter = (await git.raw(['rev-parse', 'HEAD'])).trim();
      const tagsAfter = (await git.tags(['--list', 'ok/v*'])).all;
      const statusAfter = (await git.raw(['status', '--porcelain'])).trim();

      expect(headAfter).toBe(headBefore);
      expect(tagsAfter).toEqual(tagsBefore);
      expect(statusAfter).toBe(statusBefore);
    } finally {
      await sessionManager.closeAll();
    }
  });

  test('git dir: in-flight untracked files are NOT swept by parent-git add (PRD-6716)', async () => {
    const projectDir = tmpDir;
    // Default-production wiring: contentDir == projectDir, contentRoot omitted
    // → handler resolves resolvedContentRoot to '.' and pathspec to '.'.
    const contentDir = projectDir;
    writeFileSync(join(projectDir, 'doc.md'), '# Hello\n');

    const git = simpleGit(projectDir);
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');
    writeFileSync(join(projectDir, 'README.md'), '# project\n');
    await git.add('.');
    await git.commit('initial');

    // Untracked in-flight work the user has NOT staged.
    writeFileSync(join(projectDir, 'untracked-code.ts'), 'console.log("WIP")\n');
    writeFileSync(join(projectDir, 'in-flight-secrets.txt'), 'API_KEY=sk-not-yet-rotated\n');

    const historyHandle = await initShadowRepo(projectDir);
    const shadowRef: ShadowRef = { current: historyHandle };

    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus);

    const headBefore = (await git.raw(['rev-parse', 'HEAD'])).trim();

    try {
      const ext = createApiExtension({
        hocuspocus,
        sessionManager,
        contentDir,
        projectDir,
        shadowRef,
        // contentRoot intentionally omitted → handler resolves to '.'
        getFileIndex: () => new Map(),
      });

      const req = makeJsonPostReq('/api/save-version', {});
      const { res, captured } = makeRes();
      await (
        ext as {
          onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
        }
      ).onRequest({ request: req, response: res });

      expect(captured.status).toBe(200);
      expect(typeof captured.parsed.checkpointRef).toBe('string');

      // RED contract: untracked files remain untracked (not swept into a commit).
      const headAfter = (await git.raw(['rev-parse', 'HEAD'])).trim();
      expect(headAfter).toBe(headBefore);

      const untrackedAfter = (await git.raw(['ls-files', '--others', '--exclude-standard']))
        .trim()
        .split('\n')
        .filter(Boolean);
      expect(untrackedAfter).toContain('untracked-code.ts');
      expect(untrackedAfter).toContain('in-flight-secrets.txt');
    } finally {
      await sessionManager.closeAll();
    }
  });

  test('rollback git dir: parent-git is NOT mutated (PRD-6716 sister)', async () => {
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

    // Modify the doc on disk so the rollback has work to do.
    const newContent = '# Initial\n\nVersion 2 content (modified)\n';
    writeFileSync(resolve(contentDir, `${docName}.md`), newContent);

    // Synthesize a Y.Doc-in-map "hocuspocus" so the rollback handler proceeds
    // past `hocuspocus.documents.get(docName)` (which would otherwise 409 and
    // short-circuit before the parent-git block). Same harness shape used by
    // api-rollback-actor-identity.test.ts setupRollback().
    const yDoc = new Y.Doc();
    const xmlFragment = yDoc.getXmlFragment('default');
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [new Y.XmlText('Version 2 content (modified)')]);
    xmlFragment.insert(0, [para]);
    yDoc.getText('source').insert(0, newContent);

    const shadowRef: ShadowRef = { current: shadow };
    const hocuspocusStub = {
      documents: new Map([[docName, yDoc]]),
      closeConnections() {},
      unloadDocument: async () => {},
      debouncer: {
        isDebounced: () => false,
        executeNow: async () => undefined,
      },
    };

    // `statusBefore` captures an already-dirty tree (the doc was written to disk
    // above without staging). The assertion below pins index identity: rollback
    // must NOT `git add` — so `statusAfter` stays ` M …` rather than flipping to `M …`.
    const headBefore = (await git.raw(['rev-parse', 'HEAD'])).trim();
    const statusBefore = (await git.raw(['status', '--porcelain'])).trim();

    const ext = createApiExtension({
      hocuspocus: hocuspocusStub as unknown as Parameters<
        typeof createApiExtension
      >[0]['hocuspocus'],
      sessionManager: {
        closeSession: async () => {},
        closeAllForDoc: async () => {},
      } as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
      contentDir,
      projectDir,
      shadowRef,
      contentRoot: 'content',
      getFileIndex: () => new Map(),
    });

    const req = makeJsonPostReq('/api/rollback', { docName, commitSha: priorSha });
    const { res, captured } = makeRes();
    await (
      ext as {
        onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
      }
    ).onRequest({ request: req, response: res });

    expect(captured.status).toBe(200);

    const headAfter = (await git.raw(['rev-parse', 'HEAD'])).trim();
    const statusAfter = (await git.raw(['status', '--porcelain'])).trim();

    // RED contract: rollback handler must not commit on the user's HEAD.
    expect(headAfter).toBe(headBefore);
    expect(statusAfter).toBe(statusBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Save Version unification: an empty-body request
// consolidates ALL non-park WIP chains on the active branch (not just the
// service writer); explicit writers / agentId stay scoped; the active branch is
// threaded (no hardcoded 'main').
// ─────────────────────────────────────────────────────────────────────────────

describe('PRD-6972 FR6: Save Version unification', () => {
  let tmpDir: string;
  let projectDir: string;
  let contentDir: string;
  let shadow: ShadowHandle;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-fr6-'));
    projectDir = tmpDir;
    contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const git = simpleGit(projectDir);
    await git.init();
    await git.addConfig('user.name', 'Test');
    await git.addConfig('user.email', 't@t.test');
    writeFileSync(join(projectDir, 'README.md'), '# project\n');
    await git.add('.');
    await git.commit('init');
    shadow = await initShadowRepo(projectDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeExt(getCurrentBranch?: () => string | null) {
    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus);
    const ext = createApiExtension({
      hocuspocus,
      sessionManager,
      contentDir,
      projectDir,
      shadowRef: { current: shadow } as ShadowRef,
      contentRoot: 'content',
      getFileIndex: () => new Map(),
      ...(getCurrentBranch ? { getCurrentBranch } : {}),
    });
    return { ext, sessionManager };
  }

  async function post(
    ext: ReturnType<typeof makeExt>['ext'],
    body: unknown,
  ): Promise<CapturedResponse> {
    const req = makeJsonPostReq('/api/save-version', body);
    const { res, captured } = makeRes();
    await (
      ext as {
        onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
      }
    ).onRequest({ request: req, response: res });
    return captured;
  }

  async function wipRefs(branch: string): Promise<string[]> {
    const sg = shadowGit(shadow);
    return (await sg.raw('for-each-ref', '--format=%(refname)', `refs/wip/${branch}/`))
      .trim()
      .split('\n')
      .filter(Boolean);
  }

  test('empty-body request consolidates ALL non-park WIP chains on the active branch', async () => {
    writeFileSync(join(contentDir, 'doc.md'), '# a\n');
    await commitWip(
      shadow,
      { id: 'agent-1', name: 'a1', email: 'a1@x' },
      'content',
      'wip a1',
      'main',
    );
    writeFileSync(join(contentDir, 'doc.md'), '# b\n');
    await commitWip(
      shadow,
      { id: 'agent-2', name: 'a2', email: 'a2@x' },
      'content',
      'wip a2',
      'main',
    );
    writeFileSync(join(contentDir, 'doc.md'), '# c\n');
    await commitWip(
      shadow,
      { id: 'principal-p', name: 'p', email: 'p@x' },
      'content',
      'wip p',
      'main',
    );
    expect(await wipRefs('main')).toHaveLength(3);

    const { ext, sessionManager } = makeExt();
    try {
      const captured = await post(ext, {});
      expect(captured.status).toBe(200);
      expect(typeof captured.parsed.checkpointRef).toBe('string');
      // Width collapses — every non-park WIP chain folded.
      expect(await wipRefs('main')).toHaveLength(0);
    } finally {
      await sessionManager.closeAll();
    }
  });

  test('explicit writers list stays scoped (does not fold everything)', async () => {
    await commitWip(
      shadow,
      { id: 'agent-1', name: 'a1', email: 'a1@x' },
      'content',
      'wip a1',
      'main',
    );
    await commitWip(
      shadow,
      { id: 'agent-2', name: 'a2', email: 'a2@x' },
      'content',
      'wip a2',
      'main',
    );

    const { ext, sessionManager } = makeExt();
    try {
      const captured = await post(ext, { writers: [{ id: 'agent-1', name: 'a1', email: 'a1@x' }] });
      expect(captured.status).toBe(200);
      const remaining = await wipRefs('main');
      // agent-1 folded; agent-2 untouched (scoped behavior preserved).
      expect(remaining.some((r) => r.endsWith('/agent-1'))).toBe(false);
      expect(remaining.some((r) => r.endsWith('/agent-2'))).toBe(true);
    } finally {
      await sessionManager.closeAll();
    }
  });

  test('threads the active branch (consolidates a feature branch, not main)', async () => {
    await commitWip(
      shadow,
      { id: 'agent-1', name: 'a1', email: 'a1@x' },
      'content',
      'wip',
      'feature-x',
    );
    expect(await wipRefs('feature-x')).toHaveLength(1);

    const { ext, sessionManager } = makeExt(() => 'feature-x');
    try {
      const captured = await post(ext, {});
      expect(captured.status).toBe(200);
      expect(captured.parsed.checkpointRef as string).toContain('refs/checkpoints/feature-x/');
      expect(await wipRefs('feature-x')).toHaveLength(0);
    } finally {
      await sessionManager.closeAll();
    }
  });

  test('empty-body with no WIP activity still lands a checkpoint', async () => {
    const { ext, sessionManager } = makeExt();
    try {
      const captured = await post(ext, {});
      expect(captured.status).toBe(200);
      expect(typeof captured.parsed.checkpointRef).toBe('string');
    } finally {
      await sessionManager.closeAll();
    }
  });
});
