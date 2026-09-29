import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const statPollWatchers = vi.hoisted(() => ({ swallowEvents: true, swallowed: 0 }));
afterAll(() => {
  statPollWatchers.swallowEvents = false;
});
vi.mock('../../../server/src/polled-path-watcher.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../server/src/polled-path-watcher.ts')>();
  return {
    ...actual,
    startPolledPathWatcher: (...args: Parameters<typeof actual.startPolledPathWatcher>) => {
      if (!statPollWatchers.swallowEvents) return actual.startPolledPathWatcher(...args);
      statPollWatchers.swallowed += 1;
      return Promise.resolve(async () => {});
    },
  };
});

import { HocuspocusProvider } from '@hocuspocus/provider';
import {
  bindConfigDoc,
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_PROJECT_LOCAL,
  type ConfigBinding,
} from '@inkeep/open-knowledge-core';
import * as Y from 'yjs';
import {
  createSyncWiredTestServer,
  createTestServer,
  pollUntil,
  type SyncWiredTestServer,
  type TestServer,
} from './test-harness';

const execFileAsync = promisify(execFile);

describe('PRD-7260 — persisted config change reaches in-process consumers without the watcher echo', () => {
  let srv: TestServer;
  let ydoc: Y.Doc;
  let provider: HocuspocusProvider;
  let binding: ConfigBinding;
  let projectYdoc: Y.Doc;
  let projectProvider: HocuspocusProvider;
  let projectBinding: ConfigBinding;

  beforeAll(async () => {
    const swallowedBefore = statPollWatchers.swallowed;
    srv = await createTestServer({ seedProjectConfigYml: '{}\n' });
    expect(statPollWatchers.swallowed).toBeGreaterThan(swallowedBefore);

    ydoc = new Y.Doc();
    provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${srv.port}/collab`,
      name: CONFIG_DOC_NAME_PROJECT_LOCAL,
      document: ydoc,
      connect: true,
    });
    binding = bindConfigDoc(provider, 'project-local');
    await pollUntil(() => binding.hasSynced(), 10_000);

    projectYdoc = new Y.Doc();
    projectProvider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${srv.port}/collab`,
      name: CONFIG_DOC_NAME_PROJECT,
      document: projectYdoc,
      connect: true,
    });
    projectBinding = bindConfigDoc(projectProvider, 'project');
    await pollUntil(() => projectBinding.hasSynced(), 10_000);
  }, 40_000);

  afterAll(async () => {
    binding?.dispose();
    provider?.destroy();
    ydoc?.destroy();
    projectBinding?.dispose();
    projectProvider?.destroy();
    projectYdoc?.destroy();
    await srv?.cleanup();
  });

  test('sync engine hot-applies autoSync.enabled from a client patch', async () => {
    const configPath = join(srv.contentDir, '.ok', 'local', 'config.yml');
    expect(srv.instance.syncEngine?.getStatus().syncEnabled).toBe(false);

    const result = binding.patch({ autoSync: { enabled: true } });
    expect(result.ok).toBe(true);

    await pollUntil(
      () => existsSync(configPath) && /enabled:\s*true/.test(readFileSync(configPath, 'utf-8')),
      15_000,
    );

    await pollUntil(() => srv.instance.syncEngine?.getStatus().syncEnabled === true, 15_000);
  }, 90_000);

  test('semantic search hot-applies search.semantic.enabled from a client patch', async () => {
    const statusUrl = `http://127.0.0.1:${srv.port}/api/semantic-status`;

    const before = await (await fetch(statusUrl)).json();
    expect(before.enabled).toBe(false);

    const result = binding.patch({ search: { semantic: { enabled: true } } });
    expect(result.ok).toBe(true);

    await pollUntil(async () => {
      const res = await fetch(statusUrl);
      const body = await res.json();
      return body.enabled === true;
    }, 15_000);
  }, 90_000);

  test('attachment-folder admission hot-applies from a project config patch', async () => {
    const configPath = join(srv.contentDir, '.ok', 'config.yml');
    expect(srv.instance.contentFilter.isExcluded('assets/new.png')).toBe(true);

    const result = projectBinding.patch({ content: { attachmentFolderPath: 'assets' } });
    expect(result.ok).toBe(true);

    await pollUntil(
      () =>
        existsSync(configPath) &&
        /attachmentFolderPath:\s*assets/.test(readFileSync(configPath, 'utf-8')),
      15_000,
    );

    await pollUntil(
      () => srv.instance.contentFilter.isExcluded('assets/new.png') === false,
      15_000,
    );
  }, 90_000);
});

describe('configured attachment folder composes into real Git sync without the watcher echo', () => {
  let srv: SyncWiredTestServer;
  let ydoc: Y.Doc;
  let provider: HocuspocusProvider;
  let binding: ConfigBinding;

  const readOriginFile = async (path: string): Promise<string> => {
    const { stdout } = await execFileAsync('git', [
      '--git-dir',
      srv.sync.originDir,
      'show',
      `main:${path}`,
    ]);
    return stdout;
  };

  const listOriginPaths = async (): Promise<string[]> => {
    const { stdout } = await execFileAsync('git', [
      '--git-dir',
      srv.sync.originDir,
      'ls-tree',
      '-r',
      '--name-only',
      'main',
    ]);
    return stdout.split('\n').filter(Boolean);
  };

  beforeAll(async () => {
    const swallowedBefore = statPollWatchers.swallowed;
    srv = await createSyncWiredTestServer({
      originSeed: { 'seed.txt': 'seed\n' },
      projectConfigYml: '{}\n',
    });
    expect(statPollWatchers.swallowed).toBeGreaterThan(swallowedBefore);

    ydoc = new Y.Doc();
    provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${srv.port}/collab`,
      name: CONFIG_DOC_NAME_PROJECT,
      document: ydoc,
      connect: true,
    });
    binding = bindConfigDoc(provider, 'project');
    await pollUntil(() => binding.hasSynced(), 10_000);
  }, 45_000);

  afterAll(async () => {
    binding?.dispose();
    provider?.destroy();
    ydoc?.destroy();
    await srv?.cleanup();
  });

  test('a live fixed-folder choice pushes the doc-less attachment lifecycle to origin', async () => {
    const configPath = join(srv.contentDir, '.ok', 'config.yml');
    expect(srv.instance.contentFilter.isExcluded('assets/diagram.png')).toBe(true);

    const result = binding.patch({ content: { attachmentFolderPath: 'assets' } });
    expect(result.ok).toBe(true);
    await pollUntil(
      () => /attachmentFolderPath:\s*assets/.test(readFileSync(configPath, 'utf-8')),
      15_000,
    );
    await pollUntil(
      () => srv.instance.contentFilter.isExcluded('assets/diagram.png') === false,
      15_000,
    );

    const attachmentPath = join(srv.contentDir, 'assets', 'diagram.png');
    mkdirSync(dirname(attachmentPath), { recursive: true });
    writeFileSync(attachmentPath, 'attachment-v1', 'utf-8');
    await srv.sync.engine.trigger('push');
    expect(await readOriginFile('assets/diagram.png')).toBe('attachment-v1');
    expect((await listOriginPaths()).some((path) => /\.mdx?$/.test(path))).toBe(false);

    writeFileSync(attachmentPath, 'attachment-v2', 'utf-8');
    await srv.sync.engine.trigger('push');
    expect(await readOriginFile('assets/diagram.png')).toBe('attachment-v2');

    rmSync(attachmentPath);
    await srv.sync.engine.trigger('push');
    expect(await listOriginPaths()).not.toContain('assets/diagram.png');
    expect(srv.sync.engine.getStatus().pushError).toBeUndefined();
  }, 90_000);
});

describe('PRD-7260 — reconciled config change reaches in-process consumers without the watcher echo', () => {
  let srv: TestServer;
  let ydoc: Y.Doc;
  let provider: HocuspocusProvider;
  let binding: ConfigBinding;

  beforeAll(async () => {
    const swallowedBefore = statPollWatchers.swallowed;
    srv = await createTestServer();
    expect(statPollWatchers.swallowed).toBeGreaterThan(swallowedBefore);

    ydoc = new Y.Doc();
    provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${srv.port}/collab`,
      name: CONFIG_DOC_NAME_PROJECT_LOCAL,
      document: ydoc,
      connect: true,
    });
    binding = bindConfigDoc(provider, 'project-local');
    await pollUntil(() => binding.hasSynced(), 10_000);
  }, 40_000);

  afterAll(async () => {
    binding?.dispose();
    provider?.destroy();
    ydoc?.destroy();
    await srv?.cleanup();
  });

  test('sync engine hot-applies the reconciled (disk) autoSync.enabled after a client patch', async () => {
    const configPath = join(srv.contentDir, '.ok', 'local', 'config.yml');
    expect(srv.instance.syncEngine?.getStatus().syncEnabled).toBe(false);

    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, 'autoSync:\n  enabled: true\n', 'utf-8');

    const result = binding.patch({ autoSync: { enabled: false } });
    expect(result.ok).toBe(true);

    await pollUntil(
      () =>
        existsSync(configPath) &&
        /enabled:\s*true/.test(readFileSync(configPath, 'utf-8')) &&
        !/enabled:\s*false/.test(readFileSync(configPath, 'utf-8')),
      15_000,
    );

    await pollUntil(() => binding.current().autoSync?.enabled === true, 15_000);

    await pollUntil(() => srv.instance.syncEngine?.getStatus().syncEnabled === true, 15_000);
  }, 90_000);
});
