/**
 * Rename and rollback attribution: agentId-guarded routing for the
 * `handleRenamePath` and `handleRollback` handlers. Their primary callers
 * include UI-driven paths (FileTree drag-rename, EditorPane Restore button)
 * that previously stayed anonymous when no agent identity was supplied —
 * these tests pin that invariant alongside the behavior
 * where an absent `agentId` falls back to the server-loaded principal.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import type { Principal } from '@inkeep/open-knowledge-core';
import { createApiExtension } from './api-extension.ts';
import { BacklinkIndex } from './backlink-index.ts';
import {
  __formatContributorsForTests as formatContributorsForTest,
  __resetContributorsForTests as resetContributorsForTest,
} from './contributor-tracker.ts';
import { _resetDocExtensionsForTests } from './doc-extensions.ts';
import type { FileIndexEntry } from './file-watcher.ts';
import { getMetrics, resetMetrics } from './metrics.ts';

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function makeReq(url: string, method: string, body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const readable = Readable.from(Buffer.from(raw)) as unknown as IncomingMessage;
  readable.method = method;
  readable.url = url;
  readable.headers = { host: 'localhost' };
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

function buildFileIndex(contentDir: string): ReadonlyMap<string, FileIndexEntry> {
  const index = new Map<string, FileIndexEntry>();
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const stat = statSync(fullPath);
      const docName = fullPath.slice(contentDir.length + 1).replace(/\.md$/, '');
      index.set(docName, { size: stat.size, modified: stat.mtime.toISOString() });
    }
  }
  walk(contentDir);
  return index;
}

async function buildBacklinkIndex(contentDir: string): Promise<BacklinkIndex> {
  const index = new BacklinkIndex({ projectDir: contentDir, contentDir });
  await index.rebuildFromDisk();
  return index;
}

/** Captures calls to the `flushGitCommit` hook so the leak-fix regression
 *  test can assert that handleRenamePath / handleRollback drain pending
 *  contributors into their own L2 commit instead of leaking into the next
 *  unrelated write's commit. */
type FlushGitCommitSpy = {
  readonly calls: ReadonlyArray<number>;
  fn: () => Promise<void>;
};

function createFlushGitCommitSpy(): FlushGitCommitSpy {
  const calls: number[] = [];
  const fn = async (): Promise<void> => {
    calls.push(Date.now());
  };
  return { calls, fn };
}

async function callApi(
  contentDir: string,
  url: string,
  body: unknown,
  backlinkIndex?: BacklinkIndex,
  flushGitCommit?: () => Promise<void>,
  getPrincipal?: () => Principal | null,
  contentFilter?: Parameters<typeof createApiExtension>[0]['contentFilter'],
): Promise<CapturedResponse> {
  const ext = createApiExtension({
    hocuspocus: {
      documents: new Map(),
      closeConnections() {},
      unloadDocument: async () => {},
      // Minimal debouncer stub — flushDocToGit (called by rollback/rename)
      // reads hocuspocus.debouncer.isDebounced. In this unit
      // harness there are no loaded docs and no pending debounced writes,
      // so `isDebounced` always returns false and `executeNow` is never
      // invoked. The real behavior under a live Hocuspocus instance is
      // covered end-to-end by summary-e2e.test.ts.
      debouncer: {
        isDebounced: () => false,
        executeNow: async () => undefined,
      },
    } as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
    sessionManager: {
      closeSession: async () => {},
      closeAllForDoc: async () => {},
    } as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
    contentDir,
    getFileIndex: () => buildFileIndex(contentDir),
    backlinkIndex: backlinkIndex ?? (await buildBacklinkIndex(contentDir)),
    ...(flushGitCommit ? { flushGitCommit } : {}),
    ...(getPrincipal ? { getPrincipal } : {}),
    ...(contentFilter ? { contentFilter } : {}),
  });
  const req = makeReq(url, 'POST', body);
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ok-rename-rollback-summary-'));
  resetContributorsForTest();
  resetMetrics();
  _resetDocExtensionsForTests();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('handleRenamePath (kind: file) — agentId-guarded attribution', () => {
  test('no agentId (UI-shape body) → rename succeeds with ZERO contributor entries', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'notes',
      toPath: 'renamed-notes',
    });

    expect(response.status).toBe(200);
    expect(formatContributorsForTest()).toBe('');
    expect(getMetrics().agentWriteCalls).toBe(0);
    expect(getMetrics().summariesProvided).toBe(0);
    const parsed = JSON.parse(response.body);
    expect(parsed.summary).toBeUndefined();
  });

  test('with agentId, no summary → default "Renamed X → Y" bullet attributed to new doc only', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');
    writeFileSync(join(tmpDir, 'journal.md'), '# Journal\n\nSee [[notes]].\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'notes',
      toPath: 'renamed-notes',
      agentId: 'claude-1',
      agentName: 'Claude',
    });

    expect(response.status).toBe(200);
    const body = formatContributorsForTest();
    // Exactly one contributor entry — the new doc (NOT the rewritten journal.md)
    const lines = body.split('\n').filter((l) => l.startsWith('ok-contributors:'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"docs":["renamed-notes"]');
    expect(lines[0]).toContain('"summaries":["Renamed notes → renamed-notes"]');
    expect(getMetrics().agentWriteCalls).toBe(1);
    expect(getMetrics().summariesProvided).toBe(1);
    // Default summary is well under 80 chars so no truncation.
    expect(getMetrics().summariesTruncated).toBe(0);

    const parsed = JSON.parse(response.body);
    expect(parsed.summary).toEqual({ value: 'Renamed notes → renamed-notes' });
  });

  test('with agentId + provided summary → uses provided summary (not default)', async () => {
    writeFileSync(join(tmpDir, 'old.md'), '# Old\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'old',
      toPath: 'new',
      agentId: 'claude-1',
      agentName: 'Claude',
      summary: 'Aligned naming with module layout',
    });

    expect(response.status).toBe(200);
    expect(formatContributorsForTest()).toContain(
      '"summaries":["Aligned naming with module layout"]',
    );
    // Rewrites in journal.md (if any) are the default writer's responsibility —
    // only the new doc has the attribution entry.
    expect(formatContributorsForTest().match(/ok-contributors:/g)?.length ?? 0).toBe(1);
  });

  test('with agentId, wrong-type summary → 400, no rename side-effects, no counters', async () => {
    writeFileSync(join(tmpDir, 'src.md'), '# Src\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'src',
      toPath: 'dst',
      agentId: 'claude-1',
      summary: { not: 'a string' },
    });

    expect(response.status).toBe(400);
    const summaryErr = JSON.parse(response.body) as Record<string, unknown>;
    expect(summaryErr.type).toBe('urn:ok:error:invalid-request');
    expect(typeof summaryErr.title).toBe('string');
    // File must NOT have been renamed (guard runs before the spine fires)
    expect(readFileSync(join(tmpDir, 'src.md'), 'utf-8')).toBe('# Src\n');
    expect(getMetrics().agentWriteCalls).toBe(0);
    expect(formatContributorsForTest()).toBe('');
  });

  test('with agentId + >80-char summary → truncated + truncatedFrom in response', async () => {
    writeFileSync(join(tmpDir, 'x.md'), '# X\n', 'utf-8');

    const long = 'w'.repeat(100);
    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'x',
      toPath: 'y',
      agentId: 'claude-1',
      summary: long,
    });
    const parsed = JSON.parse(response.body);
    expect(parsed.summary.truncatedFrom).toBe(100);
    expect(parsed.summary.hint).toBe('Summary truncated from 100 chars to 80 (max 80).');
    expect(getMetrics().summariesTruncated).toBe(1);
  });

  test('with agentId + overflow default (long doc paths) → server-generated default is truncated silently (no misleading hint/truncatedFrom in response; no M2 inflation)', async () => {
    // The default "Renamed X → Y" template can exceed the 80-char cap for
    // deeply-nested doc paths. The agent did not
    // submit the long string, so the response must NOT carry `truncatedFrom`,
    // `hint`, or inflate the `summariesTruncated` counter — doing so would
    // misattribute blame and muddy the "agent-provided truncation rate" signal.
    // The stored summary IS still truncated (to 79 visible + '…') so the
    // TimelinePanel bullet fits the canvas.
    const long = 'a'.repeat(50);
    writeFileSync(join(tmpDir, `${long}.md`), '# Long\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: long,
      toPath: `${long}-v2`,
      agentId: 'claude-1',
      agentName: 'Claude',
    });

    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body);
    // Default overflowed (50 + 50 + 10 chars of template = 110+), but response
    // suppresses truncation-diagnostic fields for the server-default path.
    expect(parsed.summary.value.endsWith('…')).toBe(true);
    expect(parsed.summary.truncatedFrom).toBeUndefined();
    expect(parsed.summary.hint).toBeUndefined();
    // counter stays clean — default-path truncation does not inflate it.
    expect(getMetrics().summariesTruncated).toBe(0);
    // But adoption metric IS incremented (the handler recorded a summary).
    expect(getMetrics().summariesProvided).toBe(1);
  });

  test('no agentId + wrong-type summary → 400 (validation runs unconditionally; attribution still skipped)', async () => {
    // Defensive validation: even though the rename has no UI call site today,
    // we want any future MCP-client identity-passthrough regression to surface
    // as a loud 400 rather than a silent attribution drop. Type-checking the
    // summary happens before the actor branch even runs, so a malformed
    // summary body never accidentally lands as a 200 with the summary
    // silently ignored.
    writeFileSync(join(tmpDir, 'src.md'), '# Src\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'src',
      toPath: 'dst',
      summary: 42,
    });

    expect(response.status).toBe(400);
    const summaryErr = JSON.parse(response.body) as Record<string, unknown>;
    expect(summaryErr.type).toBe('urn:ok:error:invalid-request');
    expect(typeof summaryErr.title).toBe('string');
    // File must NOT have been renamed — validation runs before the rename.
    expect(readFileSync(join(tmpDir, 'src.md'), 'utf-8')).toBe('# Src\n');
    // No attribution side-effects either (no agentId AND no principal in
    // this harness means no contributor entry would have been recorded
    // even on the success path).
    expect(formatContributorsForTest()).toBe('');
    expect(getMetrics().agentWriteCalls).toBe(0);
  });
});

describe('handleRollback — agentId-guarded attribution (regression gate)', () => {
  // handleRollback's full path requires a shadow-repo + open Y.Doc which is
  // out of reach in this fast unit-test harness. The critical invariant is
  // the agentId guard: a request without identity AND without a loaded
  // principal MUST produce zero contributor entries and zero counter
  // increments. That guard fires at the body-parse stage before any shadow
  // or Y.Doc touch, so we can exercise it by asserting the handler's
  // early-return shape AND by posting a body that WOULD otherwise flow
  // through to the shadow-repo error path.

  test('no agentId → body parses and short-circuits the attribution branch', async () => {
    // This hits the shadow-repo "not configured" 503 path, but critically
    // DOES NOT fire any contributor recording or counter work along the way.
    // If the attribution guard regressed (e.g. `extractAgentIdentity` ran
    // unconditionally), the `claude-1/Claude` defaults would be recorded
    // here.
    const response = await callApi(tmpDir, '/api/rollback', {
      docName: 'test-doc',
      commitSha: 'a'.repeat(40),
    });
    // Shadow not configured → 503 (server-side state, mirrors sync-not-active
    // / shadow-not-configured precedent). We ride it to prove no attribution
    // side-effects fired on the guard path.
    expect(response.status).toBe(503);
    expect(formatContributorsForTest()).toBe('');
    expect(getMetrics().agentWriteCalls).toBe(0);
    expect(getMetrics().summariesProvided).toBe(0);
  });

  test('with agentId but non-string summary → 400 summary-error takes precedence over shadow check', async () => {
    // When the caller supplies agentId and bogus summary, the guard path
    // still validates — the attribution branch is only entered after the
    // summary passes normalizeSummary. This proves the 400 summary-error
    // is reached BEFORE any attribution side-effect fires, even though
    // shadow-repo is unconfigured (which would otherwise return 400 first).
    const response = await callApi(tmpDir, '/api/rollback', {
      docName: 'test-doc',
      commitSha: 'a'.repeat(40),
      agentId: 'claude-1',
      summary: 42,
    });
    // The shadow-repo check runs before the body-level agentId guard in
    // the current implementation; both paths converge on 400 without
    // firing any attribution counter — that's the load-bearing invariant
    // for UI-driven rollback (EditorPane.tsx).
    expect(response.status).toBe(400);
    expect(formatContributorsForTest()).toBe('');
    expect(getMetrics().agentWriteCalls).toBe(0);
  });
});

describe('leak-fix regression', () => {
  // Prior to the fix: handleRollback called `setReconciledBase(docName, markdown)`
  // BEFORE `onStoreDocument` fired, which tripped persistence's
  // "skip write when serialized === currentBase" guard and dropped the L1 disk
  // write (and thus its `scheduleGitCommit()` call). The pending contributor
  // entry from `recordContributor(...)` then stayed in `pendingContributors`
  // until the next UNRELATED write's onStoreDocument fired — polluting that
  // commit's `ok-contributors:` line with stale "Restored to <sha>" bullets.
  // handleRenamePath has a parallel exposure because
  // `_performManagedRenameForDocs` does sync fs writes that bypass
  // Hocuspocus's onStoreDocument entirely.
  //
  // Fix: both handlers now call `flushDocToGit(<docName>, <label>)` after
  // `recordContributor`. That helper forces the per-doc L1 debouncer
  // (`onStoreDocument-<docName>`) via `executeNow`, then calls
  // `flushGitCommit?.()` to drain any pending L2 timer synchronously —
  // ensuring the rename/rollback's own commit carries its own attribution.

  test('handleRenamePath (file) with agentId triggers flushGitCommit after recordContributor', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');
    const spy = createFlushGitCommitSpy();

    const response = await callApi(
      tmpDir,
      '/api/rename-path',
      {
        kind: 'file',
        fromPath: 'notes',
        toPath: 'renamed-notes',
        agentId: 'claude-1',
        agentName: 'Claude',
      },
      undefined,
      spy.fn,
    );

    expect(response.status).toBe(200);
    // The fix calls flushDocToGit which ultimately calls flushGitCommit.
    // Note: flushDocToGit chains `l1.then(() => flushGitCommit?.())` —
    // the flush is kicked but not awaited by the handler. Give the
    // microtask queue a beat to resolve.
    await setImmediate();
    expect(spy.calls.length).toBeGreaterThanOrEqual(1);
  });

  test('handleRenamePath (file) WITHOUT agentId does NOT trigger flushGitCommit (no attribution → no flush needed)', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');
    const spy = createFlushGitCommitSpy();

    const response = await callApi(
      tmpDir,
      '/api/rename-path',
      {
        kind: 'file',
        fromPath: 'notes',
        toPath: 'renamed-notes',
      },
      undefined,
      spy.fn,
    );

    expect(response.status).toBe(200);
    await setImmediate();
    // UI-driven rename path should not kick a flush on its behalf — the
    // flush is there to drain newly-added attribution; no agentId → no
    // attribution → no flush. This also keeps UI-driven paths as lean
    // as they were.
    expect(spy.calls.length).toBe(0);
  });

  test('handleRenamePath (file) WITH wrong-type summary does NOT trigger flushGitCommit (early-return 400)', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');
    const spy = createFlushGitCommitSpy();

    const response = await callApi(
      tmpDir,
      '/api/rename-path',
      {
        kind: 'file',
        fromPath: 'notes',
        toPath: 'renamed-notes',
        agentId: 'claude-1',
        summary: 42,
      },
      undefined,
      spy.fn,
    );

    expect(response.status).toBe(400);
    await setImmediate();
    // 400 path short-circuits before recordContributor / flushDocToGit.
    expect(spy.calls.length).toBe(0);
  });
});

describe('handleRenamePath (kind: file) — extension change via explicit .md/.mdx in toPath', () => {
  test('same-base rename with .mdx in toPath physically changes extension on disk', async () => {
    // `resolveContentEntryPath` honors an explicit
    // supported extension on the destination path, so `toPath: "foo.mdx"`
    // physically renames `foo.md → foo.mdx`. The consolidated endpoint
    // preserves the same behavior for `kind: 'file'`.
    writeFileSync(join(tmpDir, 'foo.md'), '# Foo\n\nOriginal .md content.\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'foo',
      toPath: 'foo.mdx',
    });

    expect(response.status).toBe(200);
    expect(existsSync(join(tmpDir, 'foo.mdx'))).toBe(true);
    expect(existsSync(join(tmpDir, 'foo.md'))).toBe(false);
    const content = readFileSync(join(tmpDir, 'foo.mdx'), 'utf-8');
    expect(content).toContain('Original .md content');
  });

  test('name-and-ext change: rename bar.md → baz.mdx physically moves and renames', async () => {
    writeFileSync(join(tmpDir, 'bar.md'), '# Bar\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'bar',
      toPath: 'baz.mdx',
    });

    expect(response.status).toBe(200);
    expect(existsSync(join(tmpDir, 'baz.mdx'))).toBe(true);
    expect(existsSync(join(tmpDir, 'bar.md'))).toBe(false);
  });

  test('extension-less toPath preserves source extension (backward compat)', async () => {
    // Extension-less destinations rely on getDocExtension() to re-derive
    // the source's extension. Guards against a regression where the
    // explicit-extension handling breaks the pre-existing behavior.
    writeFileSync(join(tmpDir, 'qux.md'), '# Qux\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'qux',
      toPath: 'renamed-qux',
    });

    expect(response.status).toBe(200);
    expect(existsSync(join(tmpDir, 'renamed-qux.md'))).toBe(true);
    expect(existsSync(join(tmpDir, 'qux.md'))).toBe(false);
    expect(existsSync(join(tmpDir, 'renamed-qux.mdx'))).toBe(false);
  });

  test('explicit extension matching the source (foo → foo.md when foo.md exists) is a no-op', async () => {
    // Edge case when the client preserves the typed extension and the user
    // typed the same name as the source. Both the textual `fromPath === toPath`
    // short-circuit and the on-disk `sourcePath === destinationPath` short-circuit
    // must return 200 with renamed:[] rather than 409 Destination already exists.
    writeFileSync(join(tmpDir, 'stable.md'), '# Stable\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'stable',
      toPath: 'stable.md',
    });

    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body);
    expect(parsed.renamed).toEqual([]);
    expect(existsSync(join(tmpDir, 'stable.md'))).toBe(true);
  });
});

const fixturePrincipal: Principal = {
  id: 'principal-rename-fixture-9999',
  display_name: 'Miles',
  display_email: 'miles@example.test',
  source: 'git-config',
  created_at: '2026-04-29T10:00:00.000Z',
};

describe('handleRenamePath — actor identity routing', () => {
  test('UI-driven file rename (no agentId) with principal loaded → principal contributor', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');

    const response = await callApi(
      tmpDir,
      '/api/rename-path',
      { kind: 'file', fromPath: 'notes', toPath: 'renamed-notes' },
      undefined,
      undefined,
      () => fixturePrincipal,
    );

    expect(response.status).toBe(200);
    const body = formatContributorsForTest();
    const lines = body.split('\n').filter((l) => l.startsWith('ok-contributors:'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`"id":"${fixturePrincipal.id}"`);
    expect(lines[0]).toContain('"docs":["renamed-notes"]');
  });

  test('UI-driven file rename (no agentId) with NO principal loaded → no contributor (anonymous)', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'notes',
      toPath: 'renamed-notes',
    });

    expect(response.status).toBe(200);
    expect(formatContributorsForTest()).toBe('');
  });

  test('agent file rename + principal loaded → agent contributor (agent wins)', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');

    const response = await callApi(
      tmpDir,
      '/api/rename-path',
      {
        kind: 'file',
        fromPath: 'notes',
        toPath: 'renamed-notes',
        agentId: 'claude-1',
        agentName: 'Claude',
      },
      undefined,
      undefined,
      () => fixturePrincipal,
    );

    expect(response.status).toBe(200);
    const body = formatContributorsForTest();
    const lines = body.split('\n').filter((l) => l.startsWith('ok-contributors:'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"id":"agent-claude-1"');
  });

  test('file rename via consolidated endpoint rewrites inbound wiki-links (FR2/FR10)', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');
    writeFileSync(join(tmpDir, 'journal.md'), '# Journal\n\nSee [[notes]].\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'notes',
      toPath: 'renamed-notes',
    });

    expect(response.status).toBe(200);
    expect(readFileSync(join(tmpDir, 'journal.md'), 'utf-8')).toContain('[[renamed-notes]]');
    const parsed = JSON.parse(response.body);
    expect(parsed.rewrittenDocs).toEqual(
      expect.arrayContaining([expect.objectContaining({ docName: 'journal' })]),
    );
  });

  test('case-only rename succeeds and rewrites inbound wiki-links', async () => {
    writeFileSync(join(tmpDir, 'Notes.md'), '# Notes\n', 'utf-8');
    writeFileSync(join(tmpDir, 'journal.md'), '# Journal\n\nSee [[Notes]].\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'Notes',
      toPath: 'notes',
    });

    expect(response.status).toBe(200);
    expect(readdirSync(tmpDir)).toContain('notes.md');
    expect(readdirSync(tmpDir)).not.toContain('Notes.md');
    expect(readFileSync(join(tmpDir, 'journal.md'), 'utf-8')).toContain('[[notes]]');
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    expect(parsed.renamed).toEqual([{ fromDocName: 'Notes', toDocName: 'notes' }]);
  });

  test('non-string summary returns 400 before rename', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'notes',
      toPath: 'renamed-notes',
      summary: 42,
    });

    expect(response.status).toBe(400);
    expect(readFileSync(join(tmpDir, 'notes.md'), 'utf-8')).toBe('# Notes\n');
  });

  test('agent file rename with default summary "Renamed X → Y" lands on contributor entry', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'notes',
      toPath: 'renamed-notes',
      agentId: 'claude-1',
      agentName: 'Claude',
    });

    expect(response.status).toBe(200);
    const body = formatContributorsForTest();
    expect(body).toContain('"summaries":["Renamed notes → renamed-notes"]');
  });

  test('side-effect docs (backlink rewrites) stay anonymous (D-A2/NG8)', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');
    writeFileSync(join(tmpDir, 'journal.md'), '# Journal\n\nSee [[notes]].\n', 'utf-8');

    const response = await callApi(
      tmpDir,
      '/api/rename-path',
      { kind: 'file', fromPath: 'notes', toPath: 'renamed-notes' },
      undefined,
      undefined,
      () => fixturePrincipal,
    );

    expect(response.status).toBe(200);
    const body = formatContributorsForTest();
    const lines = body.split('\n').filter((l) => l.startsWith('ok-contributors:'));
    // Exactly one contributor entry — the renamed doc, NOT the rewritten journal.md
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"docs":["renamed-notes"]');
    expect(lines[0]).not.toContain('journal');
  });
});

describe('handleRenamePath — folder rename via consolidated endpoint', () => {
  test('folder rename rewrites inbound wiki-links across affected docs (FR3)', async () => {
    const setupDir = mkdtempSync(join(tmpdir(), 'ok-folder-rename-'));
    try {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(setupDir, 'articles'), { recursive: true });
      writeFileSync(join(setupDir, 'articles', 'auth.md'), '# Auth\n', 'utf-8');
      writeFileSync(join(setupDir, 'articles', 'login.md'), '# Login\n', 'utf-8');
      writeFileSync(
        join(setupDir, 'index.md'),
        '# Index\n\nSee [[articles/auth]] and [[articles/login]].\n',
        'utf-8',
      );

      const response = await callApi(setupDir, '/api/rename-path', {
        kind: 'folder',
        fromPath: 'articles',
        toPath: 'essays',
      });

      expect(response.status).toBe(200);
      const indexContent = readFileSync(join(setupDir, 'index.md'), 'utf-8');
      expect(indexContent).toContain('[[essays/auth]]');
      expect(indexContent).toContain('[[essays/login]]');
      expect(indexContent).not.toContain('[[articles/');
    } finally {
      rmSync(setupDir, { recursive: true, force: true });
    }
  });

  test('folder rename to nested non-existent destination parent succeeds (auto-create)', async () => {
    const setupDir = mkdtempSync(join(tmpdir(), 'ok-folder-rename-'));
    try {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(setupDir, 'articles'), { recursive: true });
      writeFileSync(join(setupDir, 'articles', 'auth.md'), '# Auth\n', 'utf-8');

      const response = await callApi(setupDir, '/api/rename-path', {
        kind: 'folder',
        fromPath: 'articles',
        toPath: '2026/essays',
      });

      expect(response.status).toBe(200);
      expect(readFileSync(join(setupDir, '2026/essays/auth.md'), 'utf-8')).toBe('# Auth\n');
    } finally {
      rmSync(setupDir, { recursive: true, force: true });
    }
  });

  test('UI folder rename (no agentId) with principal records principal contributor per affected doc', async () => {
    const setupDir = mkdtempSync(join(tmpdir(), 'ok-folder-rename-'));
    try {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(setupDir, 'articles'), { recursive: true });
      writeFileSync(join(setupDir, 'articles', 'auth.md'), '# Auth\n', 'utf-8');
      writeFileSync(join(setupDir, 'articles', 'login.md'), '# Login\n', 'utf-8');

      const response = await callApi(
        setupDir,
        '/api/rename-path',
        { kind: 'folder', fromPath: 'articles', toPath: 'essays' },
        undefined,
        undefined,
        () => fixturePrincipal,
      );

      expect(response.status).toBe(200);
      const body = formatContributorsForTest();
      expect(body).toContain(`"id":"${fixturePrincipal.id}"`);
      expect(body).toContain('essays/auth');
      expect(body).toContain('essays/login');
    } finally {
      rmSync(setupDir, { recursive: true, force: true });
    }
  });
});

describe('handleRenamePath — content-filter admission (FR11)', () => {
  function makeFilter(opts: {
    excludedFiles?: string[];
    excludedDirs?: string[];
  }): Parameters<typeof createApiExtension>[0]['contentFilter'] {
    const excludedFiles = new Set(opts.excludedFiles ?? []);
    const excludedDirs = new Set(opts.excludedDirs ?? []);
    return {
      isExcluded: (relativePath: string) => excludedFiles.has(relativePath),
      isDirExcluded: (relativePath: string) => excludedDirs.has(relativePath),
      getWatcherIgnoreGlobs: () => [],
      incrementMdDir: () => {},
      decrementMdDir: () => {},
    };
  }

  test('file rename to excluded destination → 400 with admission error; source untouched', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');

    const response = await callApi(
      tmpDir,
      '/api/rename-path',
      { kind: 'file', fromPath: 'notes', toPath: 'drafts/private' },
      undefined,
      undefined,
      undefined,
      makeFilter({ excludedFiles: ['drafts/private.md'] }),
    );

    expect(response.status).toBe(400);
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    expect(parsed.type).toBe('urn:ok:error:invalid-request');
    expect(String(parsed.title)).toContain('Destination document is excluded');
    expect(readFileSync(join(tmpDir, 'notes.md'), 'utf-8')).toBe('# Notes\n');
  });

  test('folder rename to excluded destination → 400 with admission error; source untouched', async () => {
    const folder = join(tmpDir, 'articles');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'auth.md'), '# Auth\n', 'utf-8');

    const response = await callApi(
      tmpDir,
      '/api/rename-path',
      { kind: 'folder', fromPath: 'articles', toPath: 'archive/old' },
      undefined,
      undefined,
      undefined,
      makeFilter({ excludedDirs: ['archive/old'] }),
    );

    expect(response.status).toBe(400);
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    expect(parsed.type).toBe('urn:ok:error:invalid-request');
    expect(String(parsed.title)).toContain('Destination folder is excluded');
    expect(readFileSync(join(folder, 'auth.md'), 'utf-8')).toBe('# Auth\n');
  });

  test('rename to admitted destination passes content-filter check (no false positive)', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');

    const response = await callApi(
      tmpDir,
      '/api/rename-path',
      { kind: 'file', fromPath: 'notes', toPath: 'renamed' },
      undefined,
      undefined,
      undefined,
      makeFilter({ excludedFiles: ['drafts/private.md'] }),
    );

    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body);
    expect(parsed.renamed).toEqual([{ fromDocName: 'notes', toDocName: 'renamed' }]);
  });

  test('contentFilter omitted → admission check is a no-op (back-compat)', async () => {
    writeFileSync(join(tmpDir, 'notes.md'), '# Notes\n', 'utf-8');

    const response = await callApi(tmpDir, '/api/rename-path', {
      kind: 'file',
      fromPath: 'notes',
      toPath: 'drafts/private',
    });

    expect(response.status).toBe(200);
  });
});
