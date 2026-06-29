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
  await execFileAsync('git', ['rm', fileName], opts);
  await execFileAsync('git', ['commit', '-m', 'oursdelete'], opts);

  await execFileAsync('git', ['merge', 'theirs-branch'], opts).catch(() => {});

  return { baseContent, theirsContent };
}

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

  await execFileAsync('git', ['checkout', '-b', 'theirs-branch'], opts);
  await execFileAsync('git', ['rm', fileName], opts);
  await execFileAsync('git', ['commit', '-m', 'theirsdelete'], opts);

  await execFileAsync('git', ['checkout', 'main'], opts);
  writeFileSync(join(contentDir, fileName), oursContent, 'utf-8');
  await execFileAsync('git', ['commit', '-am', 'oursmod'], opts);

  await execFileAsync('git', ['merge', 'theirs-branch'], opts).catch(() => {});

  return { baseContent, oursContent };
}

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

async function createDUTestServer(): Promise<TestServer> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-du-test-')));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, '.ok'), { recursive: true });
  writeFileSync(join(dir, '.ok', 'config.yml'), '', 'utf-8');
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

describe('DU (delete-modify) conflict — foundational contract', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createDUTestServer();
  }, HARNESS_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    await server.cleanup();
  });

  test('GET /api/sync/conflict-content returns kind="delete-modify" when stage 2 is absent', async () => {
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
    const discriminator = body.kind ?? body.shape ?? body.conflictKind;
    expect(discriminator).toBe('delete-modify');
  });

  test('Y.Text substitution is skipped when stage 2 is missing (no silent un-delete)', async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/sync/conflict-content?file=foo.md&source=ytext`,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ours?: string; theirs?: string };
    expect(body.theirs).toBe('their modification\n');
    expect(body.ours).not.toBe(body.theirs);
  });

  test("POST /api/sync/resolve-conflict { strategy: 'delete' } succeeds (DU stays deleted)", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-conflict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'foo.md', strategy: 'delete' }),
    });
    expect(res.status).toBe(200);

    expect(existsSync(join(server.contentDir, 'foo.md'))).toBe(false);

    const mergeHead = join(server.contentDir, '.git', 'MERGE_HEAD');
    expect(existsSync(mergeHead)).toBe(false);
  });
});

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

  test("POST /api/sync/resolve-conflict { strategy: 'delete' } succeeds (UD accepts deletion)", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-conflict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'foo.md', strategy: 'delete' }),
    });
    expect(res.status).toBe(200);

    expect(existsSync(join(server.contentDir, 'foo.md'))).toBe(false);

    const mergeHead = join(server.contentDir, '.git', 'MERGE_HEAD');
    expect(existsSync(mergeHead)).toBe(false);
  });
});

describe("POST /api/sync/resolve-conflict { strategy: 'content', content: '' }", () => {
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

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (res.status === 500) {
      const detail = typeof body.detail === 'string' ? body.detail : '';
      expect(detail).not.toContain("strategy 'content' requires content parameter");
    }

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

describe('both-modified conflict — backward compatibility', () => {
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
    await execFileAsync('git', ['merge', 'theirs-branch'], opts).catch(() => {});
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
    expect(body.ours).toBeDefined();
    expect(body.theirs).toBeDefined();
    expect(body.ours).not.toBe('');
    expect(body.theirs).not.toBe('');

    const discriminator = body.kind ?? body.shape ?? body.conflictKind;
    expect(discriminator).toBe('both-modified');

    const baseFile = readFileSync(join(server.contentDir, 'foo.md'), 'utf-8');
    expect(baseFile).toContain('<<<<<<<');
  });
});
