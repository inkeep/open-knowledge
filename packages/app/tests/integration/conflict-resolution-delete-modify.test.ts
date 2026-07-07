/**
 * Foundational-contract tests for delete-vs-modify conflict resolution.
 *
 * The conflict-resolution surface must honestly represent the user's
 * three semantic choices for any conflict shape, including the
 * missing-stage variants (delete-modify "DU" and modify-delete "UD"):
 *   - keep-mine    — working tree equals what I had locally (delete OR mod)
 *   - accept-theirs — working tree equals what they had (delete OR mod)
 *   - content       — working tree equals these specific bytes
 *
 * Four invariants are pinned here:
 *
 *   1. The server response for a missing-stage conflict carries a
 *      stage-presence discriminator (`kind: 'delete-modify' |
 *      'modify-delete' | 'both-modified'`) so the UI can pick a render
 *      branch. Without it the schema returns only `{ base, ours, theirs,
 *      lifecycleStatus }` with empty strings standing in for missing
 *      stages — indistinguishable from a legitimately-empty file.
 *
 *   2. The Y.Text-substitution path skips substitution when stage 2 is
 *      missing — without this, DU's marker-free disk bytes (= theirs) get
 *      fed into `ours`, yielding a silent un-delete.
 *
 *   3. `POST /api/sync/resolve-conflict` accepts `{ strategy: 'delete' }`,
 *      which runs `git rm <file>` + finalizes the merge commit. A wire
 *      enum closed at three elements rejects this at the Zod boundary
 *      with `urn:ok:error:invalid-request`.
 *
 *   4. `POST /api/sync/resolve-conflict { strategy: 'content', content: '' }`
 *      returns either (a) 400 with a field-specific message at the Zod
 *      boundary (preferred — the UI's accept-deletion intent should
 *      dispatch `strategy: 'delete'`, never `content: ''`), or (b) is
 *      accepted at the boundary and downstream guards do NOT throw the
 *      misleading "strategy 'content' requires content parameter" 500.
 *      The failure mode is the latter shape's 500 with misleading detail.
 *
 * Tier choice: narrow integration. The contract crosses the Zod boundary
 * + the server-authoritative bridge + the ConflictStore + git plumbing —
 * pure unit tests on `ConflictStore.resolveConflict` cover the strategy
 * mechanics, but a single-tier test cannot prove that the HTTP shape, the
 * Zod enum, the server response discriminator, AND the git mechanics all
 * line up.
 *
 * On the `content: ''` case: the `content` field has already crossed the
 * Zod trust boundary by the time it reaches the internal guard, where
 * it's typed `string` (not `string | undefined`). The `!content`
 * predicate is internal-trusted masking, not boundary defense. The fix is
 * to remove the redundant guard (TS narrows via the earlier throw) —
 * assertions below confirm the misleading message no longer fires.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ProblemDetailsSchema } from '@inkeep/open-knowledge-core';
import { HARNESS_BOOT_TIMEOUT_MS } from './harness-boot-timeout';
import { createTestServer, pollUntil, type TestServer } from './test-harness';

const execFileAsync = promisify(execFile);

/**
 * Build a DU (delete-on-our-side, modify-on-theirs) merge-conflict shape
 * INSIDE the existing test-harness contentDir, then register the file in
 * the ConflictStore so `/api/sync/conflict-content` finds it.
 *
 * git plumbing:
 *
 *   git init -b main
 *   echo "base" > foo.md ; git add ; git commit
 *   git checkout -b theirs
 *   echo "their modification" > foo.md ; git add ; git commit
 *   git checkout main
 *   git rm foo.md ; git commit
 *   git merge theirs   # → CONFLICT (modify/delete)
 *
 * Observed state post-merge:
 *   - `git status --short` → `DU foo.md`
 *   - `git ls-files -u` → stages 1 + 3 only (stage 2 absent)
 *   - On-disk foo.md → "their modification" (no markers; git leaves theirs)
 */
async function setupDUConflict(
  contentDir: string,
  fileName = 'foo.md',
): Promise<{ baseContent: string; theirsContent: string }> {
  const opts = { cwd: contentDir };
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], opts);
  await execFileAsync('git', ['config', 'user.name', 'Test'], opts);

  const baseContent = 'base content\n';
  const theirsContent = 'their modification\n';
  writeFileSync(join(contentDir, fileName), baseContent, 'utf-8');
  await execFileAsync('git', ['add', fileName], opts);
  await execFileAsync('git', ['commit', '-m', 'base'], opts);

  await execFileAsync('git', ['checkout', '-b', 'theirs-branch'], opts);
  writeFileSync(join(contentDir, fileName), theirsContent, 'utf-8');
  await execFileAsync('git', ['commit', '-am', 'theirs'], opts);

  await execFileAsync('git', ['checkout', 'main'], opts);
  // Delete locally — git rm <file> + commit.
  await execFileAsync('git', ['rm', fileName], opts);
  await execFileAsync('git', ['commit', '-m', 'oursdelete'], opts);

  // Merge attempt fails with modify/delete — that's the desired end state.
  await execFileAsync('git', ['merge', 'theirs-branch'], opts).catch(() => {
    /* expected */
  });

  return { baseContent, theirsContent };
}

/**
 * Build a UD (modify-on-our-side, delete-on-theirs) merge-conflict shape.
 *
 * Post-merge state:
 *   - `git status --short` → `UD foo.md`
 *   - `git ls-files -u` → stages 1 + 2 only (stage 3 absent)
 *   - On-disk foo.md → "our modification" (no markers; git leaves ours)
 */
async function setupUDConflict(
  contentDir: string,
  fileName = 'foo.md',
): Promise<{ baseContent: string; oursContent: string }> {
  const opts = { cwd: contentDir };
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], opts);
  await execFileAsync('git', ['config', 'user.name', 'Test'], opts);

  const baseContent = 'base content\n';
  const oursContent = 'our modification\n';
  writeFileSync(join(contentDir, fileName), baseContent, 'utf-8');
  await execFileAsync('git', ['add', fileName], opts);
  await execFileAsync('git', ['commit', '-m', 'base'], opts);

  // Theirs branch: delete the file.
  await execFileAsync('git', ['checkout', '-b', 'theirs-branch'], opts);
  await execFileAsync('git', ['rm', fileName], opts);
  await execFileAsync('git', ['commit', '-m', 'theirsdelete'], opts);

  // Main branch: modify the file.
  await execFileAsync('git', ['checkout', 'main'], opts);
  writeFileSync(join(contentDir, fileName), oursContent, 'utf-8');
  await execFileAsync('git', ['commit', '-am', 'oursmod'], opts);

  // Merge attempt → modify/delete conflict (delete on theirs side).
  await execFileAsync('git', ['merge', 'theirs-branch'], opts).catch(() => {
    /* expected */
  });

  return { baseContent, oursContent };
}

/**
 * Register a file as a tracked conflict in the test server's
 * ConflictStore. The harness's createTestServer does not run a real
 * SyncEngine merge, so we seed the store directly to make the
 * conflict-content gate admit the request.
 */
async function registerConflict(contentDir: string, file: string): Promise<void> {
  const { LOCAL_DIR } = await import('@inkeep/open-knowledge-core');
  const { mkdirSync } = await import('node:fs');
  const okLocal = join(contentDir, '.ok', LOCAL_DIR);
  mkdirSync(okLocal, { recursive: true });
  const conflictsJson = {
    version: 1,
    branch: 'main',
    conflicts: [{ file, detectedAt: new Date().toISOString() }],
  };
  writeFileSync(join(okLocal, 'conflicts.json'), JSON.stringify(conflictsJson), 'utf-8');
}

/**
 * Build a freshly-initialized git project at a tmpdir with `.ok/config.yml`,
 * then hand it to createTestServer via `contentDir`. The harness's
 * ensureProjectGit is a no-op when `.git/` already exists.
 */
async function createDUTestServer(): Promise<TestServer> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-du-test-')));
  // Seed the OK project marker so handlers admit operations.
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, '.ok'), { recursive: true });
  writeFileSync(join(dir, '.ok', 'config.yml'), '', 'utf-8');
  // Build the DU conflict BEFORE starting the server — git operations
  // mutate the workdir and would race the file-watcher otherwise.
  await execFileAsync('git', ['init', '--initial-branch=main', dir]);
  await setupDUConflict(dir);
  await registerConflict(dir, 'foo.md');
  return createTestServer({ contentDir: dir, keepContentDir: false });
}

async function createUDTestServer(): Promise<TestServer> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-ud-test-')));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, '.ok'), { recursive: true });
  writeFileSync(join(dir, '.ok', 'config.yml'), '', 'utf-8');
  await execFileAsync('git', ['init', '--initial-branch=main', dir]);
  await setupUDConflict(dir);
  await registerConflict(dir, 'foo.md');
  return createTestServer({ contentDir: dir, keepContentDir: false });
}

// ─── DU: delete-locally + modify-remotely ────────────────────────────────────

describe('DU (delete-modify) conflict — foundational contract', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createDUTestServer();
  }, HARNESS_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.cleanup();
  });

  /**
   * Pins discriminator shape `kind: 'delete-modify'`.
   * Without a discriminator field the response schema cannot let the UI
   * tell DU from a both-modified conflict where ours happens to be empty.
   * The `kind` field on `SyncConflictContentSuccessSchema` distinguishes
   * them.
   *
   */
  test('GET /api/sync/conflict-content returns kind="delete-modify" when stage 2 is absent', async () => {
    // Wait for the test server's file-watcher to index the file.
    await pollUntil(async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`).catch(() => null);
      if (!res?.ok) return false;
      const data = (await res.json()) as { documents?: Array<{ docName: string }> };
      return data.documents !== undefined;
    });

    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/sync/conflict-content?file=foo.md&source=ytext`,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    // The discriminator is the load-bearing piece of the foundational
    // contract — the UI's DiffViewBoundary branches on this to pick a
    // render variant. Both spellings are accepted by the test for
    // forward-compat.
    const discriminator = body.kind ?? body.shape ?? body.conflictKind;
    expect(discriminator).toBe('delete-modify');
  });

  /**
   * Pins the Y.Text-substitution gate.
   * Failure mode: the file-watcher seeds Y.Text with the marker-free disk
   * content (= theirs), so `ytextHasConflictMarkers` returns false and
   * `ours <- ytextOurs = theirs`. The response carries `ours === theirs`,
   * the UI sees zero hunks, Save resolution silently un-deletes.
   *
   * The fix gates Y.Text substitution on stage 2 presence — when stage 2
   * is absent, `ours` is NOT substituted with the Y.Text snapshot. The
   * contract: in a DU shape, `ours` MUST NOT equal `theirs` (or `ours`
   * is an empty string / null signaling "stage absent").
   *
   */
  test('Y.Text substitution is skipped when stage 2 is missing (no silent un-delete)', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/sync/conflict-content?file=foo.md&source=ytext`,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ours?: string; theirs?: string };
    expect(body.theirs).toBe('their modification\n');
    // The bug: today body.ours === body.theirs. The contract: ours must
    // NOT carry theirs' bytes when stage 2 was absent.
    expect(body.ours).not.toBe(body.theirs);
  });

  /**
   * strategy 'delete' is rejected at the Zod boundary by a closed enum.
   * The fix extends the wire enum + ConflictStore.ResolveStrategy and
   * wires the git mechanics (`git rm <file>` + commit).
   *
   */
  test("POST /api/sync/resolve-conflict { strategy: 'delete' } succeeds (DU stays deleted)", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-conflict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'foo.md', strategy: 'delete' }),
    });
    // Today: 400 invalid-request (Zod rejects unknown enum value).
    // After fix: 200 success.
    expect(res.status).toBe(200);

    // Post-resolve: file is gone from disk, working tree is clean.
    expect(existsSync(join(server.contentDir, 'foo.md'))).toBe(false);

    // The merge is finalized — `.git/MERGE_HEAD` should be gone.
    const mergeHead = join(server.contentDir, '.git', 'MERGE_HEAD');
    expect(existsSync(mergeHead)).toBe(false);
  });
});

// ─── UD: modify-locally + delete-remotely ────────────────────────────────────

describe('UD (modify-delete) conflict — foundational contract', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createUDTestServer();
  }, HARNESS_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.cleanup();
  });

  test('GET /api/sync/conflict-content returns kind="modify-delete" when stage 3 is absent', async () => {
    await pollUntil(async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`).catch(() => null);
      return res?.ok ?? false;
    });

    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/sync/conflict-content?file=foo.md&source=ytext`,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    const discriminator = body.kind ?? body.shape ?? body.conflictKind;
    expect(discriminator).toBe('modify-delete');
  });

  /**
   * The user's "accept their deletion" intent on UD must dispatch
   * `strategy: 'delete'` — NOT `content: ''` (the current UI path,
   * which 500s per Bug 3). The fix wires this through.
   *
   */
  test("POST /api/sync/resolve-conflict { strategy: 'delete' } succeeds (UD accepts deletion)", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-conflict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'foo.md', strategy: 'delete' }),
    });
    expect(res.status).toBe(200);

    expect(existsSync(join(server.contentDir, 'foo.md'))).toBe(false);

    // Mirror the DU assertion: the merge must be finalized. If
    // `git commit --no-edit` silently fails for the UD shape, the file
    // would be absent but MERGE_HEAD would still exist and the conflict
    // would reappear on next server restart. Symmetry with the DU test
    // catches single-side regressions in the commit path.
    const mergeHead = join(server.contentDir, '.git', 'MERGE_HEAD');
    expect(existsSync(mergeHead)).toBe(false);
  });
});

// ─── Empty-content rejection contract ────────────────────────────────────────

describe("POST /api/sync/resolve-conflict { strategy: 'content', content: '' }", () => {
  // The empty-string predicate is internal-trusted masking, not a real
  // boundary. The Zod schema is the TRUE boundary — that's where empty-
  // content should be rejected (with a field-specific message), and the
  // downstream guard should disappear.
  //
  // The fix MUST satisfy ONE of these contracts at the integration tier:
  //   (a) Schema-tier rejection: Zod refine adds `content !== ''` to the
  //       content-strategy check. 400 invalid-request with a clear
  //       message pointing at the content field. (Strongly preferred —
  //       lines up with the foundational contract: the UI's accept-
  //       deletion intent should dispatch 'delete', never 'content:""'.)
  //   (b) Pass-through: schema accepts empty content, ConflictStore
  //       writes empty bytes. NOT preferred because it allows
  //       semantically-incoherent "I want this file to exist but
  //       contain nothing" resolutions on missing-stage shapes — but
  //       the test pins what MUST NOT happen: a 500 with the misleading
  //       "strategy 'content' requires content parameter" detail.
  let server: TestServer;

  beforeAll(async () => {
    server = await createDUTestServer();
  }, HARNESS_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.cleanup();
  });

  test("empty content NEVER produces a 500 with the misleading 'requires content parameter' detail", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-conflict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'foo.md', strategy: 'content', content: '' }),
    });

    // The current bug: status === 500, body.type ===
    // 'urn:ok:error:internal-server-error', body.detail contains
    // "strategy 'content' requires content parameter".
    //
    // The fix's contract: this MUST NOT happen.
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (res.status === 500) {
      // If 500 ever fires, it MUST NOT carry the misleading message.
      const detail = typeof body.detail === 'string' ? body.detail : '';
      expect(detail).not.toContain("strategy 'content' requires content parameter");
    }

    // Strong assertion: the response MUST be either 200 (pass-through)
    // or 400 invalid-request (schema-tier rejection). 500 with ANY shape
    // is wrong because empty content is a client-side input error, not
    // a server-side fault.
    expect([200, 400]).toContain(res.status);

    if (res.status === 400) {
      const parsed = ProblemDetailsSchema.safeParse(body);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.type).toBe('urn:ok:error:invalid-request');
      }
    }
  });
});

// ─── Both-modified regression (don't break the existing happy path) ──────────

describe('both-modified conflict — backward compatibility', () => {
  // The existing modify/modify (both-modified) flow MUST continue to
  // work after the foundational-contract fix lands. Specifically:
  //   - The response shape gains a `kind: 'both-modified'` discriminator,
  //     but the existing `ours`/`theirs`
  //     fields stay populated with the live stage-2 / stage-3 content.
  //   - `strategy: 'content'` with non-empty bytes still writes those
  //     bytes to disk and finalizes the merge commit.
  let server: TestServer;
  let contentDir: string;

  beforeAll(async () => {
    contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-mm-test-')));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(contentDir, '.ok'), { recursive: true });
    writeFileSync(join(contentDir, '.ok', 'config.yml'), '', 'utf-8');
    await execFileAsync('git', ['init', '--initial-branch=main', contentDir]);
    const opts = { cwd: contentDir };
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], opts);
    await execFileAsync('git', ['config', 'user.name', 'Test'], opts);
    writeFileSync(join(contentDir, 'foo.md'), 'base\n', 'utf-8');
    await execFileAsync('git', ['add', 'foo.md'], opts);
    await execFileAsync('git', ['commit', '-m', 'base'], opts);
    await execFileAsync('git', ['checkout', '-b', 'theirs-branch'], opts);
    writeFileSync(join(contentDir, 'foo.md'), 'theirs\n', 'utf-8');
    await execFileAsync('git', ['commit', '-am', 'theirs'], opts);
    await execFileAsync('git', ['checkout', 'main'], opts);
    writeFileSync(join(contentDir, 'foo.md'), 'ours\n', 'utf-8');
    await execFileAsync('git', ['commit', '-am', 'ours'], opts);
    await execFileAsync('git', ['merge', 'theirs-branch'], opts).catch(() => {
      /* expected: conflict */
    });
    await registerConflict(contentDir, 'foo.md');

    server = await createTestServer({ contentDir, keepContentDir: false });
  }, HARNESS_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.cleanup();
  });

  test('GET /api/sync/conflict-content returns kind="both-modified" when stages 2+3 are present', async () => {
    await pollUntil(async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`).catch(() => null);
      return res?.ok ?? false;
    });

    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/sync/conflict-content?file=foo.md`,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    // Both stages present — `ours` from stage 2, `theirs` from stage 3.
    expect(body.ours).toBeDefined();
    expect(body.theirs).toBeDefined();
    expect(body.ours).not.toBe('');
    expect(body.theirs).not.toBe('');

    // Discriminator MUST be present and equal to 'both-modified' (the
    // common modify/modify case). The existing UI render branch keys
    // off this.
    const discriminator = body.kind ?? body.shape ?? body.conflictKind;
    expect(discriminator).toBe('both-modified');

    // Verify the raw bytes confirm both stages are populated.
    const baseFile = readFileSync(join(server.contentDir, 'foo.md'), 'utf-8');
    expect(baseFile).toContain('<<<<<<<');
  });
});
