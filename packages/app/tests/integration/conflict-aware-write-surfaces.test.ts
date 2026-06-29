import { describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  bootServer,
  ConfigSchema,
  getLocalDir,
  getLogger,
  restoreLifecycleFromConflictsJson,
} from '@inkeep/open-knowledge-server';
import { createTestClient, createTestServer, pollUntil, type TestServer } from './test-harness';

const execFileAsync = promisify(execFile);

const BASE_CONTENT = '# Base\n\nBase paragraph.\n';

async function setupServerWithDoc(
  docName: string,
  initial: string,
  cleanups: Array<() => Promise<void> | void>,
  options: { debounce?: number; maxDebounce?: number } = {},
): Promise<TestServer> {
  const server = await createTestServer({
    debounce: options.debounce ?? 100,
    maxDebounce: options.maxDebounce ?? 500,
  });
  cleanups.push(() => server.cleanup());
  writeFileSync(join(server.contentDir, `${docName}.md`), initial, 'utf-8');
  await pollUntil(async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`).catch(() => null);
    if (!res?.ok) return false;
    const data = (await res.json()) as { documents?: Array<{ docName: string }> };
    return data.documents?.some((d) => d.docName === docName) ?? false;
  });
  return server;
}

function seedConflictsJson(
  projectDir: string,
  entries: Array<{ file: string; detectedAt?: string }>,
): void {
  const localDir = getLocalDir(projectDir);
  mkdirSync(localDir, { recursive: true });
  const data = {
    version: 1,
    branch: 'main',
    conflicts: entries.map((e) => ({
      file: e.file,
      detectedAt: e.detectedAt ?? '2026-05-19T00:00:00.000Z',
    })),
  };
  writeFileSync(join(localDir, 'conflicts.json'), JSON.stringify(data, null, 2), 'utf-8');
}

function seedSyncStateConflicts(projectDir: string, files: string[]): void {
  const localDir = getLocalDir(projectDir);
  mkdirSync(localDir, { recursive: true });
  const state = {
    version: 1,
    lastSyncUtc: null,
    lastFetchUtc: null,
    lastPushedSha: null,
    consecutiveFailures: 0,
    inflightConflicts: files,
  };
  writeFileSync(join(localDir, 'sync-state.json'), JSON.stringify(state, null, 2), 'utf-8');
}

async function seedRealMergeConflict(projectDir: string, files: string[]): Promise<void> {
  const opts = { cwd: projectDir };
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], opts);
  await execFileAsync('git', ['config', 'user.name', 'Test'], opts);
  for (const file of files) {
    const abs = join(projectDir, file);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'base\n', 'utf-8');
  }
  await execFileAsync('git', ['add', ...files], opts);
  await execFileAsync('git', ['commit', '-m', 'base'], opts);
  await execFileAsync('git', ['checkout', '-b', 'theirs-branch'], opts);
  for (const file of files) writeFileSync(join(projectDir, file), 'theirs\n', 'utf-8');
  await execFileAsync('git', ['commit', '-am', 'theirs'], opts);
  await execFileAsync('git', ['checkout', 'main'], opts);
  for (const file of files) writeFileSync(join(projectDir, file), 'ours\n', 'utf-8');
  await execFileAsync('git', ['commit', '-am', 'ours'], opts);
  await execFileAsync('git', ['merge', 'theirs-branch'], opts).catch(() => {});
}

describe('FR1 + FR2: lifecycle swap-in / swap-out (server-observable contract)', () => {
  test('swap-in sets gate (mutations refuse); swap-out clears gate (mutations succeed); Y.Text bytes preserved', async () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    try {
      const docName = `swap-${crypto.randomUUID()}`;
      const server = await setupServerWithDoc(docName, BASE_CONTENT, cleanups);

      const dc = await server.instance.hocuspocus.openDirectConnection(docName);
      cleanups.push(() => dc.disconnect());

      const serverDoc = server.instance.hocuspocus.documents.get(docName);
      expect(serverDoc).toBeTruthy();
      if (!serverDoc) throw new Error('serverDoc missing');

      const ytextBefore = serverDoc.getText('source').toString();
      expect(ytextBefore).toContain('Base paragraph');

      const lifecycleMap = serverDoc.getMap('lifecycle');

      expect(lifecycleMap.get('status')).toBeUndefined();
      const preGateRes = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docName,
          markdown: BASE_CONTENT,
          position: 'replace',
          agentId: 'a',
          agentName: 'A',
        }),
      });
      expect(preGateRes.ok).toBe(true);

      lifecycleMap.set('status', 'conflict');
      lifecycleMap.set('reason', 'conflict-markers');

      expect(lifecycleMap.get('status')).toBe('conflict');
      expect(lifecycleMap.get('reason')).toBe('conflict-markers');

      const inConflictRes = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docName,
          markdown: '# Replacement\n',
          position: 'replace',
          agentId: 'a',
          agentName: 'A',
        }),
      });
      expect(inConflictRes.status).toBe(409);
      expect(inConflictRes.headers.get('content-type')).toContain('application/problem+json');
      const body = (await inConflictRes.json()) as Record<string, unknown>;
      expect(body.type).toBe('urn:ok:error:doc-in-conflict');

      lifecycleMap.delete('status');
      lifecycleMap.delete('reason');

      expect(lifecycleMap.get('status')).toBeUndefined();
      expect(lifecycleMap.get('reason')).toBeUndefined();

      expect(serverDoc.getText('source').toString()).toBe(ytextBefore);

      const postGateRes = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docName,
          markdown: BASE_CONTENT,
          position: 'replace',
          agentId: 'a',
          agentName: 'A',
        }),
      });
      expect(postGateRes.ok).toBe(true);
    } finally {
      while (cleanups.length > 0) await cleanups.pop()?.();
    }
  }, 30_000);
});

describe('FR11: reconciliation conflict path sets lifecycle.status and fires the FR9 gate', () => {
  test('reconcile case "conflicts" sets lifecycle.status="conflict" + mutating handler returns 409', async () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    try {
      const docName = `fr11-${crypto.randomUUID()}`;
      const baseContent = '# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n';
      const server = await createTestServer({ debounce: 60_000, maxDebounce: 60_000 });
      cleanups.push(() => server.cleanup());
      writeFileSync(join(server.contentDir, `${docName}.md`), baseContent, 'utf-8');
      await pollUntil(async () => {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`).catch(() => null);
        if (!res?.ok) return false;
        const data = (await res.json()) as { documents?: Array<{ docName: string }> };
        return data.documents?.some((d) => d.docName === docName) ?? false;
      });

      const client = await createTestClient(server.port, docName);
      cleanups.push(() => client.cleanup());
      await pollUntil(() => client.ytext.toString().includes('First paragraph'));

      const lifecycle = client.doc.getMap('lifecycle');

      const baseOffset = client.ytext.toString().indexOf('First paragraph.');
      const baseLen = 'First paragraph.'.length;
      client.doc.transact(() => {
        client.ytext.delete(baseOffset, baseLen);
        client.ytext.insert(baseOffset, 'Our version of first paragraph.');
      });
      await pollUntil(() => {
        const sd = server.instance.hocuspocus.documents.get(docName);
        return sd?.getText('source').toString().includes('Our version') ?? false;
      }, 5000);

      const theirsContent = '# Heading\n\nTheir version of first paragraph.\n\nSecond paragraph.\n';
      writeFileSync(join(server.contentDir, `${docName}.md`), theirsContent, 'utf-8');

      await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);
      expect(lifecycle.get('status')).toBe('conflict');
      expect(lifecycle.get('reason')).toBe('merged-with-markers');

      const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docName,
          markdown: '# Replacement\n',
          position: 'replace',
          agentId: 'a',
          agentName: 'A',
        }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.type).toBe('urn:ok:error:doc-in-conflict');
    } finally {
      while (cleanups.length > 0) await cleanups.pop()?.();
    }
  }, 45_000);
});

describe('FR12: /api/sync/conflicts + /api/sync/status count parity', () => {
  test('seeded 2 conflicts: /api/sync/conflicts length === 2, /api/sync/status conflictCount === 2; resolve 1 → both drop to 1', async () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    try {
      const { mkdtempSync, realpathSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-fr12-')));
      cleanups.push(() => {
        const { rmSync } = require('node:fs') as typeof import('node:fs');
        rmSync(tmpDir, { recursive: true, force: true });
      });

      mkdirSync(join(tmpDir, '.ok'), { recursive: true });
      writeFileSync(join(tmpDir, '.ok', 'config.yml'), '', 'utf-8');
      await execFileAsync('git', ['init', '--initial-branch=main', tmpDir]);
      await execFileAsync('git', ['-C', tmpDir, 'config', 'user.name', 'Test']);
      await execFileAsync('git', ['-C', tmpDir, 'config', 'user.email', 'test@test.com']);

      const fileA = `fr12-a-${crypto.randomUUID()}.md`;
      const fileB = `fr12-b-${crypto.randomUUID()}.md`;
      writeFileSync(join(tmpDir, fileA), '# A\n', 'utf-8');
      writeFileSync(join(tmpDir, fileB), '# B\n', 'utf-8');
      await execFileAsync('git', ['-C', tmpDir, 'add', '.']);
      await execFileAsync('git', ['-C', tmpDir, 'commit', '-m', 'base']);

      seedConflictsJson(tmpDir, [{ file: fileA }, { file: fileB }]);
      seedSyncStateConflicts(tmpDir, [fileA, fileB]);

      const server = await createTestServer({ contentDir: tmpDir, keepContentDir: true });
      cleanups.push(() => server.cleanup());

      const conflictsRes = await fetch(`http://127.0.0.1:${server.port}/api/sync/conflicts`);
      expect(conflictsRes.ok).toBe(true);
      const conflictsBody = (await conflictsRes.json()) as {
        conflicts: Array<{ file: string }>;
      };
      expect(conflictsBody.conflicts).toHaveLength(2);
      const files = conflictsBody.conflicts.map((c) => c.file).sort();
      expect(files).toEqual([fileA, fileB].sort());

      const statusRes = await fetch(`http://127.0.0.1:${server.port}/api/sync/status`);
      expect(statusRes.ok).toBe(true);
      const statusBody = (await statusRes.json()) as { conflictCount: number };
      expect(statusBody.conflictCount).toBe(2);

      const resolveRes = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-conflict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: fileA,
          strategy: 'content',
          content: '# A resolved\n',
        }),
      });
      expect(resolveRes.ok).toBe(true);

      const conflictsRes2 = await fetch(`http://127.0.0.1:${server.port}/api/sync/conflicts`);
      const conflictsBody2 = (await conflictsRes2.json()) as {
        conflicts: Array<{ file: string }>;
      };
      expect(conflictsBody2.conflicts).toHaveLength(1);
      expect(conflictsBody2.conflicts[0]?.file).toBe(fileB);

      const statusRes2 = await fetch(`http://127.0.0.1:${server.port}/api/sync/status`);
      const statusBody2 = (await statusRes2.json()) as { conflictCount: number };
      expect(statusBody2.conflictCount).toBe(1);
    } finally {
      while (cleanups.length > 0) await cleanups.pop()?.();
    }
  }, 45_000);
});

describe('FR14: lifecycle restore function (in-process; CI-runnable)', () => {
  test('restoreLifecycleFromConflictsJson sets lifecycle.status on each tracked doc', async () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    try {
      const docName = `fr14-fn-${crypto.randomUUID()}`;
      const server = await setupServerWithDoc(docName, BASE_CONTENT, cleanups);
      await seedRealMergeConflict(server.contentDir, [`${docName}.md`]);
      seedConflictsJson(server.contentDir, [{ file: `${docName}.md` }]);

      const warnLines: string[] = [];
      const originalWarn = console.warn;
      console.warn = (msg: unknown, ...rest: unknown[]) => {
        warnLines.push(typeof msg === 'string' ? msg : String(msg));
        originalWarn.call(console, msg, ...rest);
      };
      cleanups.push(() => {
        console.warn = originalWarn;
      });

      await restoreLifecycleFromConflictsJson({
        hocuspocus: server.instance.hocuspocus,
        projectDir: server.contentDir,
        log: getLogger('fr14-fn-test'),
      });

      const dc = await server.instance.hocuspocus.openDirectConnection(docName);
      try {
        const lifecycleMap = dc.document?.getMap('lifecycle');
        expect(lifecycleMap?.get('status')).toBe('conflict');
        expect(lifecycleMap?.get('reason')).toBe('conflict-markers');
      } finally {
        await dc.disconnect();
      }

      const restoredEvent = warnLines.find((l) => {
        try {
          const parsed = JSON.parse(l) as { event?: string; 'doc.name'?: string };
          return (
            parsed.event === 'lifecycle-restored-from-conflicts-json' &&
            parsed['doc.name'] === docName
          );
        } catch (e) {
          if (e instanceof SyntaxError) return false;
          throw e;
        }
      });
      expect(restoredEvent).toBeDefined();

      const res = await fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docName,
          markdown: '# replacement\n',
          position: 'replace',
          agentId: 'a',
          agentName: 'A',
        }),
      });
      expect(res.status).toBe(409);
    } finally {
      while (cleanups.length > 0) await cleanups.pop()?.();
    }
  }, 30_000);

  test('restoreLifecycleFromConflictsJson is a no-op when conflicts.json is missing', async () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    try {
      const docName = `fr14-fn-empty-${crypto.randomUUID()}`;
      const server = await setupServerWithDoc(docName, BASE_CONTENT, cleanups);
      await restoreLifecycleFromConflictsJson({
        hocuspocus: server.instance.hocuspocus,
        projectDir: server.contentDir,
        log: getLogger('fr14-fn-test'),
      });

      const dc = await server.instance.hocuspocus.openDirectConnection(docName);
      try {
        const lifecycleMap = dc.document?.getMap('lifecycle');
        expect(lifecycleMap?.get('status')).toBeUndefined();
      } finally {
        await dc.disconnect();
      }
    } finally {
      while (cleanups.length > 0) await cleanups.pop()?.();
    }
  }, 30_000);
});

describe('on-load lifecycle seed from ConflictStore (runtime race fix)', () => {
  async function runOnLoadSeedTest(extension: '.md' | '.mdx') {
    const cleanups: Array<() => Promise<void> | void> = [];

    const warnLines: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: unknown, ...rest: unknown[]) => {
      warnLines.push(typeof msg === 'string' ? msg : String(msg));
      originalWarn.call(console, msg, ...rest);
    };
    cleanups.push(() => {
      console.warn = originalWarn;
    });

    try {
      const { mkdtempSync, realpathSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-onload-seed-')));
      cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));

      await execFileAsync('git', ['init', '--initial-branch=main', tmpDir]);
      mkdirSync(join(tmpDir, '.ok'), { recursive: true });
      writeFileSync(join(tmpDir, '.ok', 'config.yml'), '', 'utf-8');
      writeFileSync(join(tmpDir, '.ok', '.gitignore'), '', 'utf-8');

      const docName = `onload-${crypto.randomUUID()}`;
      const fileName = `${docName}${extension}`;

      await seedRealMergeConflict(tmpDir, [fileName]);
      seedConflictsJson(tmpDir, [{ file: fileName }]);

      const server = await createTestServer({
        contentDir: tmpDir,
        keepContentDir: true,
        debounce: 100,
        maxDebounce: 500,
      });
      cleanups.push(() => server.cleanup());

      await pollUntil(async () => {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`).catch(() => null);
        if (!res?.ok) return false;
        const data = (await res.json()) as { documents?: Array<{ docName: string }> };
        return data.documents?.some((d) => d.docName === docName) ?? false;
      }, 5_000);

      const client = await createTestClient(server.port, docName, {
        skipInvariantWatcher: true,
      });
      cleanups.push(() => client.cleanup());

      const lifecycle = client.doc.getMap('lifecycle');
      await pollUntil(() => lifecycle.get('status') === 'conflict', 10_000);
      expect(lifecycle.get('status')).toBe('conflict');
      expect(lifecycle.get('reason')).toBe('conflict-markers');

      const seededEvent = warnLines.find((l) => {
        try {
          const parsed = JSON.parse(l) as { event?: string; 'doc.name'?: string };
          return (
            parsed.event === 'lifecycle-seeded-on-load-from-conflict-store' &&
            parsed['doc.name'] === docName
          );
        } catch (e) {
          if (e instanceof SyntaxError) return false;
          throw e;
        }
      });
      expect(seededEvent).toBeDefined();
    } finally {
      while (cleanups.length > 0) await cleanups.pop()?.();
    }
  }

  test('.md  — first client connect seeds lifecycle.status="conflict" from ConflictStore', async () => {
    await runOnLoadSeedTest('.md');
  }, 30_000);

  test('.mdx — first client connect seeds lifecycle.status="conflict" from ConflictStore', async () => {
    await runOnLoadSeedTest('.mdx');
  }, 30_000);
});

const describeBoot = process.env.CI ? describe.skip : describe;

describeBoot('FR14: boot-time lifecycle restoration from conflicts.json', () => {
  test('conflicts.json with entry X → lifecycle.status="conflict" set + immediate POST returns 409', async () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    try {
      const { mkdtempSync, realpathSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-fr14-')));
      cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));

      await execFileAsync('git', ['init', '--initial-branch=main', tmpDir]);
      mkdirSync(join(tmpDir, '.ok'), { recursive: true });
      writeFileSync(join(tmpDir, '.ok', 'config.yml'), '', 'utf-8');
      writeFileSync(join(tmpDir, '.ok', '.gitignore'), '', 'utf-8');
      const fileName = `fr14-${crypto.randomUUID()}.md`;
      await seedRealMergeConflict(tmpDir, [fileName]);
      seedConflictsJson(tmpDir, [{ file: fileName }]);

      const warnLines: string[] = [];
      const originalWarn = console.warn;
      console.warn = (msg: unknown, ...rest: unknown[]) => {
        warnLines.push(typeof msg === 'string' ? msg : String(msg));
        originalWarn.call(console, msg, ...rest);
      };
      cleanups.push(() => {
        console.warn = originalWarn;
      });

      const booted = await bootServer({
        config: ConfigSchema.parse({}),
        contentDir: tmpDir,
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
        attachUiSibling: false,
      });
      cleanups.push(() => booted.destroy());

      const docName = fileName.replace(/\.md$/, '');
      const dc = await booted.serverInstance.hocuspocus.openDirectConnection(docName);
      try {
        const lifecycleMap = dc.document?.getMap('lifecycle');
        expect(lifecycleMap?.get('status')).toBe('conflict');
        expect(lifecycleMap?.get('reason')).toBe('conflict-markers');
      } finally {
        await dc.disconnect();
      }

      const restoredEvent = warnLines.find((l) => {
        try {
          const parsed = JSON.parse(l) as { event?: string; 'doc.name'?: string };
          return (
            parsed.event === 'lifecycle-restored-from-conflicts-json' &&
            parsed['doc.name'] === docName
          );
        } catch (e) {
          if (e instanceof SyntaxError) return false;
          throw e;
        }
      });
      expect(restoredEvent).toBeDefined();

      const res = await fetch(`http://127.0.0.1:${booted.port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docName,
          markdown: '# Replacement\n',
          position: 'replace',
          agentId: 'a',
          agentName: 'A',
        }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.type).toBe('urn:ok:error:doc-in-conflict');
    } finally {
      while (cleanups.length > 0) await cleanups.pop()?.();
    }
  }, 30_000);
});

describe('FR16: "Keep mine" dispatched as strategy="content" writes the bytes the user saw (CH-H1)', () => {
  test('content-strategy resolution writes the Y.Text snapshot (CH-H1 round-trip)', async () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    try {
      const docName = `fr16-${crypto.randomUUID()}`;
      const fileName = `${docName}.md`;
      const server = await createTestServer({ debounce: 60_000, maxDebounce: 60_000 });
      cleanups.push(() => server.cleanup());

      writeFileSync(join(server.contentDir, fileName), BASE_CONTENT, 'utf-8');
      await execFileAsync('git', ['-C', server.contentDir, 'config', 'user.name', 'Test']);
      await execFileAsync('git', [
        '-C',
        server.contentDir,
        'config',
        'user.email',
        'test@test.com',
      ]);
      await execFileAsync('git', ['-C', server.contentDir, 'add', fileName]);
      await execFileAsync('git', ['-C', server.contentDir, 'commit', '-m', 'base']);

      await pollUntil(async () => {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/documents`).catch(() => null);
        if (!res?.ok) return false;
        const data = (await res.json()) as { documents?: Array<{ docName: string }> };
        return data.documents?.some((d) => d.docName === docName) ?? false;
      });

      const client = await createTestClient(server.port, docName);
      cleanups.push(() => client.cleanup());
      await pollUntil(() => client.ytext.toString().includes('Base paragraph'));

      const editMarker = '\n\nUSER EDIT typed mid-session.\n';
      client.doc.transact(() => {
        client.ytext.insert(client.ytext.length, editMarker);
      });
      await pollUntil(() => {
        const sd = server.instance.hocuspocus.documents.get(docName);
        return sd?.getText('source').toString().includes('USER EDIT') ?? false;
      }, 5000);

      const diskBefore = readFileSync(join(server.contentDir, fileName), 'utf-8');
      expect(diskBefore).toBe(BASE_CONTENT);
      expect(diskBefore).not.toContain('USER EDIT');

      const serverDoc = server.instance.hocuspocus.documents.get(docName);
      if (!serverDoc) throw new Error(`serverDoc not found for ${docName}`);
      const lifecycleMap = serverDoc.getMap('lifecycle');
      lifecycleMap.set('status', 'conflict');
      lifecycleMap.set('reason', 'conflict-markers');
      expect(lifecycleMap.get('status')).toBe('conflict');
      expect(lifecycleMap.get('reason')).toBe('conflict-markers');

      const { ConflictStore } = await import('../../../server/src/conflict-storage.ts');
      const otherFile = `fr16-other-${crypto.randomUUID()}.md`;
      writeFileSync(join(server.contentDir, otherFile), '# Other\n', 'utf-8');
      await execFileAsync('git', ['-C', server.contentDir, 'add', otherFile]);
      await execFileAsync('git', ['-C', server.contentDir, 'commit', '-m', 'other base']);
      const store = new ConflictStore(server.contentDir, 'main');
      store.addConflict({ file: fileName, detectedAt: '2026-05-19T00:00:00.000Z' });
      store.addConflict({ file: otherFile, detectedAt: '2026-05-19T00:00:00.000Z' });

      const ourBytes = client.ytext.toString();
      expect(ourBytes).toContain('Base paragraph');
      expect(ourBytes).toContain('USER EDIT');

      await store.resolveConflict(fileName, 'content', ourBytes);

      const diskAfter = readFileSync(join(server.contentDir, fileName), 'utf-8');
      expect(diskAfter).toBe(ourBytes);
      expect(diskAfter).toContain('USER EDIT');
    } finally {
      while (cleanups.length > 0) await cleanups.pop()?.();
    }
  }, 45_000);
});

describe('FR17: Conflicts list HTTP shape (data feed the sidebar section consumes)', () => {
  test('seeded conflicts surface via /api/sync/conflicts; resolve → list drops; auto-hide-at-zero is observable via empty array', async () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    try {
      const { mkdtempSync, realpathSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-fr17-')));
      cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));

      mkdirSync(join(tmpDir, '.ok'), { recursive: true });
      writeFileSync(join(tmpDir, '.ok', 'config.yml'), '', 'utf-8');
      await execFileAsync('git', ['init', '--initial-branch=main', tmpDir]);

      const fileA = `fr17-a-${crypto.randomUUID()}.md`;
      const fileB = `fr17-b-${crypto.randomUUID()}.md`;
      await seedRealMergeConflict(tmpDir, [fileA, fileB]);

      seedConflictsJson(tmpDir, [{ file: fileA }, { file: fileB }]);
      seedSyncStateConflicts(tmpDir, [fileA, fileB]);

      const server = await createTestServer({ contentDir: tmpDir, keepContentDir: true });
      cleanups.push(() => server.cleanup());

      const beforeRes = await fetch(`http://127.0.0.1:${server.port}/api/sync/conflicts`);
      expect(beforeRes.ok).toBe(true);
      const beforeBody = (await beforeRes.json()) as {
        conflicts: Array<{ file: string; detectedAt: string }>;
      };
      expect(beforeBody.conflicts).toHaveLength(2);
      const fileSet = new Set(beforeBody.conflicts.map((c) => c.file));
      expect(fileSet.has(fileA)).toBe(true);
      expect(fileSet.has(fileB)).toBe(true);
      for (const entry of beforeBody.conflicts) {
        expect(typeof entry.detectedAt).toBe('string');
      }

      const resolveRes = await fetch(`http://127.0.0.1:${server.port}/api/sync/resolve-conflict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file: fileA,
          strategy: 'content',
          content: '# A resolved\n',
        }),
      });
      expect(resolveRes.ok).toBe(true);

      const afterRes = await fetch(`http://127.0.0.1:${server.port}/api/sync/conflicts`);
      const afterBody = (await afterRes.json()) as { conflicts: Array<{ file: string }> };
      expect(afterBody.conflicts).toHaveLength(1);
      expect(afterBody.conflicts[0]?.file).toBe(fileB);

      const { mkdtempSync: mkdtempSync2, realpathSync: realpathSync2 } = await import('node:fs');
      const tmpDir2 = realpathSync2(mkdtempSync2(join(tmpdir(), 'ok-fr17-empty-')));
      cleanups.push(() => rmSync(tmpDir2, { recursive: true, force: true }));
      mkdirSync(join(tmpDir2, '.ok'), { recursive: true });
      writeFileSync(join(tmpDir2, '.ok', 'config.yml'), '', 'utf-8');
      await execFileAsync('git', ['init', '--initial-branch=main', tmpDir2]);
      const server2 = await createTestServer({ contentDir: tmpDir2, keepContentDir: true });
      cleanups.push(() => server2.cleanup());
      const emptyRes = await fetch(`http://127.0.0.1:${server2.port}/api/sync/conflicts`);
      const emptyBody = (await emptyRes.json()) as { conflicts: Array<{ file: string }> };
      expect(emptyBody.conflicts).toHaveLength(0);

      const storedPath = join(getLocalDir(tmpDir), 'conflicts.json');
      expect(existsSync(storedPath)).toBe(true);
      const stored = JSON.parse(readFileSync(storedPath, 'utf-8')) as {
        conflicts: Array<{ file: string }>;
      };
      expect(stored.conflicts).toHaveLength(1);
      expect(stored.conflicts[0]?.file).toBe(fileB);
    } finally {
      while (cleanups.length > 0) await cleanups.pop()?.();
    }
  }, 45_000);
});
