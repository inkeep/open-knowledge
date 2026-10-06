import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { applyAgentMarkdownWrite } from './agent-sessions.ts';
import type { BootedServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';
import { tracedAtomicFs } from './fs-traced.ts';

test.each(['stalled', 'completes'] as const)(
  'a %s HTTP mutation respects the pre-flush shutdown budget',
  async (outcome) => {
    const root = mkdtempSync(join(tmpdir(), 'ok-stalled-mutation-'));
    const replacementProject = mkdtempSync(join(tmpdir(), 'ok-stalled-replacement-'));
    mkdirSync(join(replacementProject, '.ok'));
    writeFileSync(join(replacementProject, '.ok', 'config.yml'), '');
    writeFileSync(join(replacementProject, '.ok', '.gitignore'), '*\n');
    writeFileSync(join(root, 'note.md'), '# Before\n');
    writeFileSync(join(root, 'live.md'), '# Live\n');
    const staged = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let owner: BootedServer | undefined;
    let pending: Promise<unknown> | undefined;
    try {
      owner = await bootCompositionRig(root, {
        destroyTimeoutMs: 500,
        debounce: 20_000,
        maxDebounce: 20_000,
      });
      await owner.ready;
      const live = await owner.serverInstance.sessionManager.getSession('live', 'stalled-drain');
      live.dc.document.transact(() => {
        applyAgentMarkdownWrite(live.dc.document, '\nFLUSHED-WHILE-MUTATION-STALLED\n', 'append');
      }, live.origin);
      const store = owner.serverInstance.hocuspocus.storeDocumentHooks(live.dc.document, {
        clientsCount: 0,
        document: live.dc.document,
        documentName: 'live',
        lastContext: {},
        lastTransactionOrigin: live.origin,
        instance: owner.serverInstance.hocuspocus,
      });
      expect(readFileSync(join(root, 'live.md'), 'utf8')).toBe('# Live\n');
      const manager = owner.serverInstance.sessionManager;
      const getSession = manager.getSession.bind(manager);
      vi.spyOn(manager, 'getSession').mockImplementation(async (...args) => {
        const session = await getSession(...args);
        if (args[0] === 'note') {
          staged.resolve();
          await release.promise;
        }
        return session;
      });
      pending = fetch(`http://127.0.0.1:${owner.port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          docName: 'note',
          position: 'replace',
          markdown: '# Delayed\n',
          agentId: 'stalled',
        }),
      }).then(
        (response) => response.text(),
        (error) => error,
      );
      await staged.promise;
      const retiring = owner.serverInstance.destroy();
      if (outcome === 'completes') {
        const probe = await fetch(`http://127.0.0.1:${owner.port}/api/agent-write-md`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ docName: 'probe', position: 'replace', markdown: '# Probe\n' }),
        });
        expect(probe.status).toBe(503);
        release.resolve();
        await pending;
      }
      await retiring;
      await store;
      expect(readFileSync(join(root, 'live.md'), 'utf8')).toContain(
        'FLUSHED-WHILE-MUTATION-STALLED',
      );
      if (outcome === 'stalled') {
        await expect(bootCompositionRig(root, { projectDir: replacementProject })).rejects.toThrow(
          /content ownership/,
        );
        expect(readFileSync(join(root, 'note.md'), 'utf8')).toBe('# Before\n');
      } else {
        const replacement = await bootCompositionRig(root, { projectDir: replacementProject });
        try {
          await replacement.ready;
          expect(readFileSync(join(root, 'note.md'), 'utf8')).toBe('# Delayed\n');
        } finally {
          await replacement.destroy();
        }
      }
      release.resolve();
      await pending;
    } finally {
      release.resolve();
      vi.restoreAllMocks();
      await pending;
      await owner?.destroy().catch(() => {});
      rmSync(root, { recursive: true, force: true });
      rmSync(replacementProject, { recursive: true, force: true });
    }
  },
  30_000,
);

test('a pending document load retains ownership until it settles and retires', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-loading-authority-'));
  const contentDir = join(root, 'content');
  const replacementProject = join(root, 'replacement');
  mkdirSync(contentDir);
  mkdirSync(join(replacementProject, '.ok'), { recursive: true });
  writeFileSync(join(replacementProject, '.ok', 'config.yml'), '');
  writeFileSync(join(replacementProject, '.ok', '.gitignore'), '');
  writeFileSync(join(contentDir, 'note.md'), '# Before\n');
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let owner: BootedServer | undefined;
  let loading:
    | ReturnType<BootedServer['serverInstance']['hocuspocus']['openDirectConnection']>
    | undefined;
  let retiring: Promise<void> | undefined;
  let replacement: BootedServer | undefined;
  try {
    owner = await bootCompositionRig(contentDir);
    await owner.ready;
    owner.serverInstance.hocuspocus.configuration.extensions.unshift({
      async onLoadDocument({ documentName }) {
        if (documentName !== 'note') return;
        entered.resolve();
        await release.promise;
      },
    });
    loading = owner.serverInstance.hocuspocus.openDirectConnection('note');
    await entered.promise;
    retiring = owner.serverInstance.destroy();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        retiring.then(() => 'retired'),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve('loading'), 1_000);
        }),
      ]);
      expect(outcome).toBe('loading');
    } finally {
      clearTimeout(timer);
    }
    await expect(
      bootCompositionRig(contentDir, { projectDir: replacementProject }),
    ).rejects.toThrow(/content ownership is already held/i);
    release.resolve();
    const connection = await loading;
    await connection.disconnect();
    await retiring;
    await owner.destroy();
    owner = undefined;
    replacement = await bootCompositionRig(contentDir, { projectDir: replacementProject });
    await replacement.ready;
  } finally {
    release.resolve();
    await loading?.then((connection) => connection.disconnect()).catch(() => {});
    await retiring;
    await replacement?.destroy();
    await owner?.destroy();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test.each(['internal', 'http'] as const)(
  'retirement protects a replacement from a staged %s conflict write',
  async (entry) => {
    const root = mkdtempSync(join(tmpdir(), 'ok-retirement-authority-'));
    const contentDir = join(root, 'content');
    const replacementProject = join(root, 'replacement');
    for (const project of [root, replacementProject]) {
      mkdirSync(join(project, '.ok'), { recursive: true });
      writeFileSync(join(project, '.ok', 'config.yml'), '');
      writeFileSync(join(project, '.ok', '.gitignore'), '');
    }
    mkdirSync(contentDir);
    writeFileSync(join(contentDir, 'note.md'), '# Before\n');
    const staged = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const delayed = '# Delayed old writer\n';
    const write = tracedAtomicFs.writeFile;
    const staging = vi.spyOn(tracedAtomicFs, 'writeFile').mockImplementation(async (...args) => {
      await write(...args);
      if (args[1] === delayed) {
        staged.resolve();
        await release.promise;
      }
    });
    let old: BootedServer | undefined;
    let replacement: BootedServer | undefined;
    let pending: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
    let retiring: Promise<void> | undefined;
    try {
      old = await bootCompositionRig(contentDir, { projectDir: root });
      await old.ready;
      old.serverInstance.conflicts.raise({
        kind: 'reconcile',
        file: 'content/note.md',
        reason: 'stale-external-write',
        stages: { base: '# Before\n', ours: '# Before\n', theirs: '# Before\n' },
      });
      const operation =
        entry === 'internal'
          ? old.serverInstance.conflicts.resolve('content/note.md', 'content', delayed)
          : fetch(`http://127.0.0.1:${old.port}/api/sync/resolve-conflict`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                file: 'content/note.md',
                strategy: 'content',
                content: delayed,
                agentId: 'old',
              }),
            }).then(async (response) => {
              expect(response.status).toBe(200);
              await response.text();
            });
      pending = operation.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await Promise.race([
        staged.promise,
        pending.then((result) => {
          throw new Error(`Write did not stage: ${JSON.stringify(result)}`);
        }),
      ]);
      staging.mockRestore();
      if (entry === 'http') {
        retiring = old.serverInstance.destroy();
        await expect(
          bootCompositionRig(contentDir, { projectDir: replacementProject }),
        ).rejects.toThrow(/content ownership is already held/i);
        release.resolve();
        expect(await pending).toEqual({ ok: true });
        await retiring;
      }
      await old.destroy();
      old = undefined;
      replacement = await bootCompositionRig(contentDir, { projectDir: replacementProject });
      await replacement.ready;
      const updated = await fetch(`http://127.0.0.1:${replacement.port}/api/agent-write-md`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          docName: 'note',
          markdown: '# New owner\n',
          position: 'replace',
          agentId: 'new',
        }),
      });
      expect(updated.status).toBe(200);
      await updated.text();
      release.resolve();
      if (entry === 'internal') {
        const result = await pending;
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('Retired writer unexpectedly published');
        expect(result.error).toMatchObject({ name: 'ServerMutationShuttingDownError' });
      }
      expect(readFileSync(join(contentDir, 'note.md'), 'utf8')).toBe('# New owner\n');
    } finally {
      staging.mockRestore();
      release.resolve();
      await pending;
      await retiring;
      await replacement?.destroy();
      await old?.destroy();
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);
