import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { testAuthorityRegistryPath } from '../../../test-support/server-authority-registry.test-helper.ts';
import * as assetWalk from './asset-walk.ts';
import { BacklinkIndex } from './backlink-index.ts';
import { type BootedServer, bootServer } from './boot.ts';
import { bootCompositionRig } from './composition-rig.test-helper.ts';
import { ConfigSchema } from './config/schema.ts';
import * as contentFilterModule from './content-filter.ts';
import { DerivedDocumentIndex } from './derived-document-index.ts';
import { getLogger } from './logger.ts';
import { ServerLockCollisionError } from './server-lock.ts';

function seedProject(projectDir: string): void {
  mkdirSync(join(projectDir, '.ok'), { recursive: true });
  writeFileSync(join(projectDir, '.ok', 'config.yml'), '');
  writeFileSync(join(projectDir, '.ok', '.gitignore'), '');
}

test('missing cached documents wait for offline removal reconciliation, not existing documents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-offline-removal-'));
  seedProject(root);
  writeFileSync(join(root, 'plain.md'), '# Plain\n');
  const index = new BacklinkIndex({ projectDir: root, contentDir: root });
  index.updateDocumentFromMarkdown('deleted', '# Cached\n');
  await index.saveToDisk();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const originalLoad = BacklinkIndex.prototype.loadFromDisk;
  vi.spyOn(BacklinkIndex.prototype, 'loadFromDisk').mockImplementation(async function (branch) {
    entered.resolve();
    await release.promise;
    return originalLoad.call(this, branch);
  });
  let owner: BootedServer | undefined;
  let missingAuth: Promise<string> | undefined;
  try {
    owner = await bootCompositionRig(root);
    await Promise.race([
      entered.promise,
      owner.ready.then(() => {
        throw new Error('Startup completed without reaching the paused cache load');
      }),
    ]);
    const guard = owner.serverInstance.hocuspocus.configuration.extensions.find(
      (entry) => '__kind' in entry && entry.__kind === 'removal-redirect-guard',
    );
    if (guard?.onAuthenticate === undefined) throw new Error('Removal guard absent');
    const originalGuard = guard.onAuthenticate.bind(guard);
    const removalEntered = Promise.withResolvers<void>();
    vi.spyOn(guard, 'onAuthenticate').mockImplementation((payload) => {
      const result = originalGuard(payload);
      if (payload.documentName === 'deleted') removalEntered.resolve();
      return result;
    });
    let settled = false;
    missingAuth = authenticate(owner.port, 'deleted').then((result) => {
      settled = true;
      return result;
    });
    void missingAuth.catch(() => {});
    await removalEntered.promise;
    expect(await authenticate(owner.port, 'plain')).toBe('authenticated');
    expect(await authenticate(owner.port, '__config__/project')).toBe('authenticated');
    expect(settled).toBe(false);
    release.resolve();
    expect(await missingAuth).toContain('doc-deleted');
    await owner.ready;
    expect(existsSync(join(root, 'deleted.md'))).toBe(false);
    expect(await authenticate(owner.port, 'new-page')).toBe('authenticated');
  } finally {
    release.resolve();
    await missingAuth?.catch(() => {});
    vi.restoreAllMocks();
    await owner?.destroy();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('failed startup logs why missing-document admission is refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-removal-boot-failure-'));
  const failure = new Error('Injected startup failure before offline reconciliation');
  vi.spyOn(DerivedDocumentIndex.prototype, 'beginStartup').mockImplementationOnce(() => {
    throw failure;
  });
  const errors = vi.spyOn(getLogger('server'), 'error');
  let owner: BootedServer | undefined;
  try {
    owner = await bootCompositionRig(root);
    await expect(owner.ready).rejects.toBe(failure);
    expect(await authenticate(owner.port, 'missing')).toBe('permission-denied');
    expect(errors).toHaveBeenCalledWith(
      { err: failure, docName: 'missing' },
      '[removal-guard] missing-document admission refused after startup failure',
    );
  } finally {
    vi.restoreAllMocks();
    await owner?.destroy();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test.each(['rebuild', 'skill-ingestion'] as const)(
  'missing-document admission does not await startup %s',
  async (phase) => {
    const root = mkdtempSync(join(tmpdir(), 'ok-removal-ready-'));
    seedProject(root);
    if (phase === 'skill-ingestion') {
      const index = new BacklinkIndex({ projectDir: root, contentDir: root });
      index.updateDocumentFromMarkdown('deleted', '# Cached\n');
      await index.saveToDisk();
    }
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    if (phase === 'rebuild') {
      const original = BacklinkIndex.prototype.rebuildFromDisk;
      vi.spyOn(BacklinkIndex.prototype, 'rebuildFromDisk').mockImplementation(
        async function (branch) {
          entered.resolve();
          await release.promise;
          return original.call(this, branch);
        },
      );
    } else {
      const original = BacklinkIndex.prototype.ingestGlobalSkillBundles;
      vi.spyOn(BacklinkIndex.prototype, 'ingestGlobalSkillBundles').mockImplementation(
        async function (...args) {
          entered.resolve();
          await release.promise;
          return original.apply(this, args);
        },
      );
    }
    let owner: BootedServer | undefined;
    try {
      owner = await bootCompositionRig(root);
      await Promise.race([
        entered.promise,
        owner.ready.then(() => {
          throw new Error(`Startup completed without reaching paused ${phase}`);
        }),
      ]);
      expect(await authenticate(owner.port, 'new-page')).toBe('authenticated');
      if (phase === 'skill-ingestion')
        expect(await authenticate(owner.port, 'deleted')).toContain('doc-deleted');
    } finally {
      release.resolve();
      vi.restoreAllMocks();
      await owner?.destroy();
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test('startup refreshes embeds loaded before asset indexes without blocking authentication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-auth-ready-'));
  writeFileSync(join(root, 'note.md'), '# Note\n\n![[photo.png]]\n');
  writeFileSync(join(root, 'plain.md'), '# Plain\n');
  writeFileSync(join(root, 'photo.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  const seeded = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const originalSeed = assetWalk.seedBasenameIndex;
  const gate = vi.spyOn(assetWalk, 'seedBasenameIndex').mockImplementation(async (options) => {
    seeded.resolve();
    await release.promise;
    return originalSeed(options);
  });
  let owner: BootedServer | undefined;
  let auth: Promise<string> | undefined;
  let loading:
    | ReturnType<BootedServer['serverInstance']['hocuspocus']['openDirectConnection']>
    | undefined;
  try {
    owner = await bootCompositionRig(root);
    await Promise.race([
      seeded.promise,
      owner.ready.then(() => {
        throw new Error('Startup completed without reaching paused asset seeding');
      }),
    ]);
    for (const name of [
      '__system__',
      '__user__/config.yml',
      '__config__/project',
      '__local__/project',
      '__config__/okignore',
    ]) {
      expect(await authenticate(owner.port, name)).toBe('authenticated');
    }
    const extension = owner.serverInstance.hocuspocus.configuration.extensions.find(
      (entry) => '__kind' in entry && entry.__kind === 'principal-auth',
    );
    if (extension?.onAuthenticate === undefined) throw new Error('Authentication extension absent');
    const originalAuth = extension.onAuthenticate.bind(extension);
    const entered = Promise.withResolvers<void>();
    let completed = false;
    vi.spyOn(extension, 'onAuthenticate').mockImplementation((payload) => {
      const pending = Promise.resolve(originalAuth(payload));
      void pending.then(() => {
        completed = true;
      });
      entered.resolve();
      return pending;
    });
    auth = authenticate(owner.port, 'note');
    await entered.promise;
    expect(await auth).toBe('authenticated');
    expect(completed).toBe(true);
    expect(await authenticate(owner.port, 'new-before-assets')).toBe('authenticated');
    const plain = await owner.serverInstance.hocuspocus.openDirectConnection('plain');
    expect(plain.document.getText('source').toString()).toBe('# Plain\n');
    await plain.disconnect();
    loading = owner.serverInstance.hocuspocus.openDirectConnection('note');
    const connection = await loading;
    expect(connection.document.getText('source').toString()).toBe('# Note\n\n![[photo.png]]\n');
    release.resolve();
    await owner.ready;
    const image = connection.document
      .getXmlFragment('default')
      .toArray()
      .find((node) => node instanceof Y.XmlElement && node.nodeName === 'jsxComponent');
    expect(image).toBeInstanceOf(Y.XmlElement);
    if (!(image instanceof Y.XmlElement)) throw new Error('Embed absent');
    expect(image.getAttribute('props')).toMatchObject({ src: '/photo.png' });
    await connection.disconnect();
  } finally {
    release.resolve();
    await auth;
    await loading?.then((connection) => connection.disconnect()).catch(() => {});
    vi.restoreAllMocks();
    gate.mockRestore();
    await owner?.destroy();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('a rejected alias startup preserves the live owner’s discovery lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-alias-authority-'));
  const content = join(root, 'content');
  const alias = join(root, 'project-alias');
  mkdirSync(content);
  symlinkSync(content, alias, 'junction');
  let owner: BootedServer | undefined;
  try {
    owner = await bootCompositionRig(content);
    await owner.ready;
    const lock = join(owner.serverInstance.lockDir, 'server.lock');
    await expect(
      bootServer({
        authorityRegistryPath: testAuthorityRegistryPath,
        contentDir: content,
        projectDir: alias,
        config: ConfigSchema.parse({}),
        port: 0,
        quiet: true,
        gitEnabled: false,
        configHomedirOverride: join(root, 'home'),
      }),
    ).rejects.toBeInstanceOf(ServerLockCollisionError);
    expect(existsSync(lock)).toBe(true);
    expect(JSON.parse(readFileSync(lock, 'utf8')).port).toBe(owner.port);
  } finally {
    await owner?.destroy();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test('a failed project lock releases the new content claim before retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-primary-authority-'));
  const content = join(root, 'content');
  const project = join(root, 'project');
  mkdirSync(content);
  seedProject(project);
  const local = join(project, '.ok', 'local');
  mkdirSync(local);
  const lock = join(local, 'server.lock');
  writeFileSync(
    lock,
    JSON.stringify({
      pid: process.ppid,
      hostname: 'fixture',
      port: 9999,
      startedAt: new Date().toISOString(),
      worktreeRoot: project,
    }),
  );
  let owner: BootedServer | undefined;
  try {
    await expect(
      bootServer({
        authorityRegistryPath: testAuthorityRegistryPath,
        contentDir: content,
        projectDir: project,
        config: ConfigSchema.parse({}),
        port: 0,
        quiet: true,
        gitEnabled: false,
        configHomedirOverride: join(root, 'home'),
      }),
    ).rejects.toThrow(/already running at port 9999/);
    unlinkSync(lock);
    owner = await bootCompositionRig(content, {
      projectDir: project,
      configHomedirOverride: join(root, 'home'),
    });
    await owner.ready;
  } finally {
    await owner?.destroy();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

async function authenticate(port: number, documentName: string): Promise<string> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/collab`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Authentication timed out')), 10_000);
      socket.on('error', reject);
      socket.on('message', (message) => {
        const decoder = decoding.createDecoder(new Uint8Array(message as Buffer));
        decoding.readVarString(decoder);
        if (decoding.readVarUint(decoder) !== 2) return;
        const subtype = decoding.readVarUint(decoder);
        if (subtype !== 1 && subtype !== 2) return;
        clearTimeout(timer);
        resolve(subtype === 1 ? decoding.readVarString(decoder) : 'authenticated');
      });
      socket.once('open', () => {
        const encoder = encoding.createEncoder();
        encoding.writeVarString(encoder, documentName);
        encoding.writeVarUint(encoder, 2);
        encoding.writeVarUint(encoder, 0);
        encoding.writeVarString(encoder, '');
        encoding.writeVarString(encoder, '4.0.0-rc.1');
        socket.send(encoding.toUint8Array(encoder));
      });
    });
  } finally {
    clearTimeout(timer);
    await new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      socket.once('close', () => resolve());
      socket.terminate();
    });
  }
}

test('nested servers cannot acquire authority over each other’s documents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-nested-authority-'));
  const nested = join(root, 'public', 'knowledge');
  mkdirSync(join(root, '.ok'), { recursive: true });
  mkdirSync(join(nested, '.ok'), { recursive: true });
  writeFileSync(join(root, '.ok', 'config.yml'), '');
  writeFileSync(join(nested, '.ok', 'config.yml'), '');
  writeFileSync(join(root, 'parent.md'), '# Parent\n');
  writeFileSync(join(nested, 'child.md'), '# Child\n');
  mkdirSync(join(root, '.ok', 'local'));
  writeFileSync(
    join(root, '.ok', 'local', 'conflicts.json'),
    JSON.stringify({
      version: 2,
      branch: 'main',
      conflicts: [
        {
          kind: 'reconcile',
          file: 'public/knowledge/child.md',
          branch: 'main',
          reason: 'stale-external-write',
          detectedAt: new Date().toISOString(),
          stages: { base: '# Child\n', ours: '# Parent conflict\n', theirs: '# Child\n' },
        },
      ],
    }),
  );
  let parent: BootedServer | undefined;
  let child: BootedServer | undefined;

  async function request(port: number, path: string, body?: unknown) {
    const response = await fetch(
      `http://127.0.0.1:${port}${path}`,
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
    return { status: response.status, body: await response.json() };
  }

  try {
    parent = await bootCompositionRig(root);
    child = await bootCompositionRig(nested, { lockKind: 'mcp-spawned' });
    await Promise.all([parent.ready, child.ready]);
    const conflict = await request(parent.port, '/api/sync/resolve-conflict', {
      file: 'public/knowledge/child.md',
      strategy: 'content',
      content: '# Wrong conflict owner\n',
      agentId: 'wrong-owner',
    });
    expect(conflict.status).toBe(403);
    expect(readFileSync(join(nested, 'child.md'), 'utf8')).toBe('# Child\n');

    const parentRead = await request(parent.port, '/api/document?docName=public/knowledge/child');
    expect(parentRead.status).toBe(403);
    expect(parentRead.body.detail).toContain('Open that project instead');
    const parentWrite = await request(parent.port, '/api/agent-write-md', {
      docName: 'public/knowledge/child',
      markdown: '# Wrong owner\n',
      position: 'replace',
      agentId: 'wrong-owner',
    });
    expect(parentWrite.status).toBe(403);
    expect(readFileSync(join(nested, 'child.md'), 'utf8')).toBe('# Child\n');
    expect(parent.serverInstance.hocuspocus.documents.has('public/knowledge/child')).toBe(false);
    await expect(
      parent.serverInstance.hocuspocus.openDirectConnection('public/knowledge/child'),
    ).rejects.toThrow(/nested project/i);
    await expect(authenticate(parent.port, 'public/knowledge/child')).resolves.toBe(
      'permission-denied',
    );
    await expect(authenticate(child.port, 'child')).resolves.toBe('authenticated');

    const deleteParentFolder = await request(parent.port, '/api/delete-path', {
      kind: 'folder',
      path: 'public',
      agentId: 'wrong-owner',
    });
    expect(deleteParentFolder.status).toBe(403);
    const duplicateParentFolder = await request(parent.port, '/api/duplicate-path', {
      kind: 'folder',
      path: 'public',
      agentId: 'wrong-owner',
    });
    expect(duplicateParentFolder.status).toBe(403);
    const moveParentFolder = await request(parent.port, '/api/rename-path', {
      kind: 'folder',
      fromPath: 'public',
      toPath: 'moved',
      agentId: 'wrong-owner',
    });
    expect(moveParentFolder.status).toBe(403);
    expect(readFileSync(join(nested, 'child.md'), 'utf8')).toBe('# Child\n');

    const childWrite = await request(child.port, '/api/agent-write-md', {
      docName: 'child',
      markdown: '# Child\n\nUpdated by its own server.\n',
      position: 'replace',
      agentId: 'right-owner',
    });
    expect(childWrite.status).toBe(200);
    const childRead = await request(child.port, '/api/document?docName=child');
    expect(childRead.body.content).toBe('# Child\n\nUpdated by its own server.\n');
    const ownParentWrite = await request(parent.port, '/api/agent-write-md', {
      docName: 'parent',
      markdown: '# Parent updated\n',
      position: 'replace',
      agentId: 'parent-owner',
    });
    expect(ownParentWrite.status).toBe(200);

    unlinkSync(join(nested, '.ok', 'config.yml'));
    const form = new FormData();
    form.set('file', new Blob(['asset bytes'], { type: 'text/plain' }), 'note.txt');
    form.set('parentDocName', 'public/knowledge/child');
    form.set('placement', 'parent-dir');
    const upload = await fetch(`http://127.0.0.1:${parent.port}/api/upload`, {
      method: 'POST',
      body: form,
    });
    expect(upload.status).toBe(403);
    expect(
      (await request(parent.port, '/api/document?docName=public/knowledge/child')).status,
    ).toBe(403);
    expect(
      (
        await request(parent.port, '/api/delete-path', {
          kind: 'folder',
          path: 'public',
          agentId: 'wrong-owner',
        })
      ).status,
    ).toBe(403);

    const lateBody = {
      docName: 'late/note',
      markdown: '# Before\n',
      position: 'replace',
      agentId: 'cached-owner',
    };
    expect((await request(parent.port, '/api/agent-write-md', lateBody)).status).toBe(200);
    mkdirSync(join(root, 'late', '.ok'));
    writeFileSync(join(root, 'late', '.ok', 'config.yml'), '');
    expect((await request(parent.port, '/api/document?docName=late/note')).status).toBe(403);
    expect(
      (await request(parent.port, '/api/agent-write-md', { ...lateBody, markdown: '# After\n' }))
        .status,
    ).toBe(403);
    expect(readFileSync(join(root, 'late', 'note.md'), 'utf8')).toBe('# Before\n');
  } finally {
    await child?.destroy();
    await parent?.destroy();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test('synchronous construction failure releases its content claim before retry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-failed-authority-'));
  seedProject(root);
  const fault = vi.spyOn(contentFilterModule, 'createContentFilter').mockImplementationOnce(() => {
    throw new Error('Construction fault');
  });
  let replacement: BootedServer | undefined;
  try {
    await expect(
      bootServer({
        authorityRegistryPath: testAuthorityRegistryPath,
        contentDir: root,
        config: ConfigSchema.parse({}),
        port: 0,
        quiet: true,
        gitEnabled: false,
        configHomedirOverride: join(root, 'home'),
      }),
    ).rejects.toThrow('Construction fault');
    fault.mockRestore();
    replacement = await bootCompositionRig(root);
    await replacement.ready;
  } finally {
    fault.mockRestore();
    await replacement?.destroy();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test.each(['parent-first', 'child-first'])(
  'custom content scopes refuse overlap (%s)',
  async (order) => {
    const root = mkdtempSync(join(tmpdir(), 'ok-custom-authority-'));
    const content = join(root, 'content');
    const nested = join(content, 'nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'note.md'), '# Untouched\n');
    const firstContent = order === 'parent-first' ? content : nested;
    const secondContent = order === 'parent-first' ? nested : content;
    seedProject(join(root, 'first'));
    seedProject(join(root, 'second'));
    const boot = (dir: string, project: string) =>
      bootServer({
        authorityRegistryPath: testAuthorityRegistryPath,
        contentDir: dir,
        projectDir: join(root, project),
        config: ConfigSchema.parse({}),
        configHomedirOverride: join(root, 'home'),
        host: '127.0.0.1',
        port: 0,
        quiet: true,
        gitEnabled: false,
        idleShutdownMs: null,
      });
    let first: BootedServer | undefined;
    let replacement: BootedServer | undefined;
    try {
      first = await boot(firstContent, 'first');
      await first.ready;
      first.serverInstance.conflicts.raise({
        kind: 'working-tree',
        file: '.ok/config.yml',
        theirsSha: 'unread-blob',
      });
      await expect(
        first.serverInstance.conflicts.resolve('.ok/config.yml', 'mine'),
      ).resolves.toBeUndefined();
      await expect(boot(secondContent, 'second')).rejects.toThrow(
        /content ownership is already held/i,
      );
      expect(readFileSync(join(nested, 'note.md'), 'utf8')).toBe('# Untouched\n');
      await first.destroy();
      first = undefined;
      replacement = await boot(secondContent, 'second');
      await replacement.ready;
    } finally {
      await replacement?.destroy();
      await first?.destroy();
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);

test('single-file previews own only their file and block project takeover until retirement', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'ok-preview-authority-'));
  const root = join(fixture, 'content');
  mkdirSync(root);
  writeFileSync(join(root, 'one.md'), '# One\n');
  writeFileSync(join(root, 'two.md'), '# Two\n');
  seedProject(join(fixture, 'preview-one'));
  seedProject(join(fixture, 'preview-two'));
  let preview: BootedServer | undefined;
  let sibling: BootedServer | undefined;
  let project: BootedServer | undefined;
  const write = async (server: BootedServer, docName: string) =>
    fetch(`http://127.0.0.1:${server.port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        docName,
        markdown: '# Updated\n',
        position: 'replace',
        agentId: 'preview-owner',
      }),
    });
  try {
    preview = await bootCompositionRig(root, {
      projectDir: join(fixture, 'preview-one'),
      ephemeral: true,
      singleDocRelPath: 'one.md',
    });
    sibling = await bootCompositionRig(root, {
      projectDir: join(fixture, 'preview-two'),
      ephemeral: true,
      singleDocRelPath: 'two.md',
    });
    await Promise.all([preview.ready, sibling.ready]);
    for (const docName of [
      '__user__/config.yml',
      '__config__/project',
      '__local__/project',
      '__config__/okignore',
    ]) {
      await expect(authenticate(preview.port, docName)).resolves.toBe('authenticated');
    }
    expect((await write(preview, 'two')).status).toBe(403);
    expect((await write(preview, 'one')).status).toBe(200);
    for (const path of ['/api/lint/markdownlint-config', '/api/lint/frontmatter-schema']) {
      const configWrite = await fetch(`http://127.0.0.1:${preview.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ruleId: 'MD013', value: false }),
      });
      expect(configWrite.status).toBe(403);
      expect((await configWrite.json()).type).toBe('urn:ok:error:single-file-mode');
    }
    const clientLogs = await fetch(`http://127.0.0.1:${preview.port}/api/client-logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: [] }),
    });
    expect(clientLogs.status).toBe(200);
    const comment = await fetch(`http://127.0.0.1:${preview.port}/api/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(comment.status).toBe(400);
    await expect(preview.serverInstance.hocuspocus.openDirectConnection('two')).rejects.toThrow(
      /does not own/i,
    );
    await expect(authenticate(preview.port, 'two')).resolves.toBe('permission-denied');
    const create = await fetch(`http://127.0.0.1:${preview.port}/api/create-page`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'new' }),
    });
    expect(create.status).toBe(403);
    await expect(bootCompositionRig(root)).rejects.toThrow(/content ownership is already held/i);
    expect(readFileSync(join(root, 'two.md'), 'utf8')).toBe('# Two\n');
    await sibling.destroy();
    sibling = undefined;
    await preview.destroy();
    preview = undefined;
    project = await bootCompositionRig(root);
    await project.ready;
    expect(readFileSync(join(root, 'one.md'), 'utf8')).toBe('# Updated\n');
  } finally {
    await project?.destroy();
    await sibling?.destroy();
    await preview?.destroy();
    rmSync(fixture, { recursive: true, force: true });
  }
}, 60_000);
