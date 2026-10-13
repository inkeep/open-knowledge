import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import {
  bindConfigDoc,
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_PROJECT_LOCAL,
  CONFIG_DOC_NAME_USER,
  type ConfigBinding,
  ConfigSchema,
} from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { removeAllDuringTeardown } from '../stress/_helpers/teardown-fs.ts';
import { createTestClient, createTestServer, pollUntil, type TestServer } from './test-harness';

interface BoundConfig {
  readonly binding: ConfigBinding;
  close(): void;
}

interface IsolatedServer extends TestServer {
  readonly home: string;
}

interface ServerResetBody {
  readonly scope: 'server';
  readonly residue: {
    readonly loadedDocuments: readonly string[];
    readonly clientConnections: number;
    readonly agentSessions: number;
    readonly agentPresence: readonly string[];
    readonly staleExternalWrites: readonly string[];
    readonly removedDocuments: readonly string[];
  };
}

const NO_RESIDUE: ServerResetBody['residue'] = {
  loadedDocuments: [],
  clientConnections: 0,
  agentSessions: 0,
  agentPresence: [],
  staleExternalWrites: [],
  removedDocuments: [],
};

const opened: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of opened.splice(0).reverse()) await close();
});

async function isolatedServer(): Promise<IsolatedServer> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ok-reset-home-')));
  opened.push(() => removeAllDuringTeardown(home));
  const server = await createTestServer({
    configHomedirOverride: home,
    seedProjectConfigYml: '{}\n',
  });
  opened.push(() => server.cleanup());
  return { ...server, home };
}

async function bindConfig(
  server: TestServer,
  docName: string,
  scope: Parameters<typeof bindConfigDoc>[1],
): Promise<BoundConfig> {
  const document = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `${server.wsUrl}/collab`,
    name: docName,
    document,
  });
  const binding = bindConfigDoc(provider, scope);
  const close = () => {
    binding.dispose();
    provider.destroy();
    document.destroy();
  };
  opened.push(close);
  await pollUntil(() => binding.hasSynced(), 10_000, 100, `${docName} to sync`);
  return { binding, close };
}

async function openClientThatStaysAway(
  server: TestServer,
  docName: string,
): Promise<{ readonly provider: HocuspocusProvider; readonly document: Y.Doc }> {
  const websocket = new HocuspocusProviderWebsocket({
    url: `${server.wsUrl}/collab`,
    delay: 600_000,
    minDelay: 600_000,
  });
  const document = new Y.Doc();
  const provider = new HocuspocusProvider({
    websocketProvider: websocket,
    name: docName,
    document,
  });
  provider.attach();
  opened.push(() => {
    provider.destroy();
    websocket.destroy();
    document.destroy();
  });
  await pollUntil(() => provider.isSynced, 10_000, 100, `${docName} to sync`);
  return { provider, document };
}

async function semanticSearchEnabled(server: TestServer): Promise<boolean> {
  const response = await fetch(`${server.baseUrl}/api/semantic-status`);
  const body = (await response.json()) as { enabled: boolean };
  return body.enabled;
}

async function pageNames(server: TestServer): Promise<string[]> {
  const response = await fetch(`${server.baseUrl}/api/pages`);
  const body = (await response.json()) as { pages: Array<{ docName: string }> };
  return body.pages.map((page) => page.docName);
}

async function resetServer(server: TestServer): Promise<Response> {
  return fetch(`${server.baseUrl}/api/test-reset?scope=server`, { method: 'POST' });
}

async function agentWrite(server: TestServer, docName: string, markdown: string): Promise<void> {
  const response = await fetch(`${server.baseUrl}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      docName,
      markdown,
      position: 'replace',
      agentId: 'reset-probe',
      agentName: 'Reset probe',
      clientName: 'reset-probe',
    }),
  });
  if (!response.ok) throw new Error(`agent-write-md returned ${response.status}`);
}

async function saveEverySettingScope(server: IsolatedServer): Promise<void> {
  const project = await bindConfig(server, CONFIG_DOC_NAME_PROJECT, 'project');
  const local = await bindConfig(server, CONFIG_DOC_NAME_PROJECT_LOCAL, 'project-local');
  const user = await bindConfig(server, CONFIG_DOC_NAME_USER, 'user');
  expect(project.binding.patch({ content: { attachmentFolderPath: 'assets' } }).ok).toBe(true);
  expect(local.binding.patch({ search: { semantic: { enabled: true } } }).ok).toBe(true);
  expect(user.binding.patch({ appearance: { theme: 'dark' } }).ok).toBe(true);
  await pollUntil(
    () =>
      existsSync(projectConfigPath(server)) &&
      readFileSync(projectConfigPath(server), 'utf-8').includes('assets') &&
      existsSync(localConfigPath(server)) &&
      existsSync(userConfigPath(server)),
    15_000,
    100,
    'all three setting scopes to persist',
  );
  await pollUntil(
    () => !server.instance.contentFilter.isExcluded('assets/new.png'),
    15_000,
    100,
    'the attachment folder to apply',
  );
  await pollUntil(() => semanticSearchEnabled(server), 15_000, 100, 'semantic search to enable');
  project.close();
  local.close();
  user.close();
}

function projectConfigPath(server: TestServer): string {
  return join(server.contentDir, '.ok', 'config.yml');
}

function localConfigPath(server: TestServer): string {
  return join(server.contentDir, '.ok', 'local', 'config.yml');
}

function userConfigPath(server: IsolatedServer): string {
  return join(server.home, '.ok', 'global.yml');
}

describe('test-reset with scope=server returns an isolated server to its booted state', () => {
  test('a local setting saved by one run is gone from disk and from its consumers after the reset', async () => {
    const server = await isolatedServer();
    const local = await bindConfig(server, CONFIG_DOC_NAME_PROJECT_LOCAL, 'project-local');
    expect(local.binding.patch({ search: { semantic: { enabled: true } } }).ok).toBe(true);
    await pollUntil(() => existsSync(localConfigPath(server)), 15_000, 100, 'the local config');
    await pollUntil(() => semanticSearchEnabled(server), 15_000, 100, 'semantic search to enable');
    local.close();

    const response = await resetServer(server);

    expect(response.status).toBe(200);
    expect(existsSync(localConfigPath(server))).toBe(false);
    expect(await semanticSearchEnabled(server)).toBe(false);
  }, 60_000);

  test('project, local and user settings saved by one run read as defaults to the next run', async () => {
    const server = await isolatedServer();
    await saveEverySettingScope(server);

    const response = await resetServer(server);

    expect(response.status).toBe(200);
    expect(existsSync(projectConfigPath(server))).toBe(false);
    expect(existsSync(localConfigPath(server))).toBe(false);
    expect(existsSync(userConfigPath(server))).toBe(false);
    expect(server.instance.contentFilter.isExcluded('assets/new.png')).toBe(true);
    expect(await semanticSearchEnabled(server)).toBe(false);
    const defaults = ConfigSchema.parse({});
    for (const [docName, scope] of [
      [CONFIG_DOC_NAME_PROJECT, 'project'],
      [CONFIG_DOC_NAME_PROJECT_LOCAL, 'project-local'],
      [CONFIG_DOC_NAME_USER, 'user'],
    ] as const) {
      const next = await bindConfig(server, docName, scope);
      expect(next.binding.current(), docName).toEqual(defaults);
    }
  }, 90_000);

  test('a connected client, an agent session, a removal record and the documents they loaded are gone after the reset', async () => {
    const server = await isolatedServer();
    writeFileSync(join(server.contentDir, 'scratch.md'), 'kept on disk\n', 'utf-8');
    await openClientThatStaysAway(server, 'scratch');
    await openClientThatStaysAway(server, CONFIG_DOC_NAME_PROJECT);
    await agentWrite(server, 'agent-notes', 'written by an agent\n');
    await agentWrite(server, 'gone', 'deleted before the reset\n');
    const deleted = await fetch(`${server.baseUrl}/api/delete-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'file', path: 'gone' }),
    });
    expect(deleted.status).toBe(200);
    expect(server.instance.hocuspocus.documents.has('scratch')).toBe(true);
    expect(server.instance.sessionManager.liveSessionCount).toBeGreaterThan(0);

    const response = await resetServer(server);

    expect(response.status).toBe(200);
    const body = (await response.json()) as ServerResetBody;
    expect(body).toEqual({ scope: 'server', residue: NO_RESIDUE });
    expect(readFileSync(join(server.contentDir, 'scratch.md'), 'utf-8')).toBe('kept on disk\n');
  }, 60_000);

  test('a page deleted just before the reset leaves no removal record once the server has seen the deletion on disk', async () => {
    const contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-reset-removal-')));
    opened.push(() => removeAllDuringTeardown(contentDir));
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ok-reset-home-')));
    opened.push(() => removeAllDuringTeardown(home));
    writeFileSync(join(contentDir, 'test-doc.md'), '', 'utf-8');
    mkdirSync(join(contentDir, '.ok'));
    writeFileSync(join(contentDir, '.ok', 'config.yml'), '{}\n', 'utf-8');
    mkdirSync(join(contentDir, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(contentDir, 'sidebar-folder'));
    writeFileSync(join(contentDir, 'sidebar-folder', 'nested-doc.md'), '', 'utf-8');
    const server = await createTestServer({
      contentDir,
      keepContentDir: true,
      configHomedirOverride: home,
    });
    let running = true;
    opened.push(async () => {
      if (running) await server.cleanup();
    });
    writeFileSync(join(contentDir, 'sidebar-folder', 'left-behind.md'), '# earlier run\n', 'utf-8');
    await pollUntil(
      async () => (await pageNames(server)).includes('sidebar-folder/left-behind'),
      30_000,
      100,
      'the server to see a page an earlier run left on disk',
    );

    const deleted = await fetch(`${server.baseUrl}/api/delete-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'file', path: 'sidebar-folder/left-behind' }),
    });
    expect(deleted.status).toBe(200);
    const response = await resetServer(server);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ scope: 'server', residue: NO_RESIDUE });
    expect(
      readdirSync(join(contentDir, '.ok')).filter((name) =>
        name.startsWith('watcher-settle-fence-'),
      ),
    ).toEqual([]);
    writeFileSync(join(contentDir, 'sidebar-folder', 'after-reset.md'), '', 'utf-8');
    await pollUntil(
      async () => (await pageNames(server)).includes('sidebar-folder/after-reset'),
      30_000,
      100,
      'the server to see a page written after the reset',
    );
    running = false;
    await server.cleanup();
    const journal = JSON.parse(
      readFileSync(join(contentDir, '.ok', 'local', 'removed-docs.json'), 'utf-8'),
    ) as { entries: Array<{ docName: string }> };
    expect(journal.entries.map((entry) => entry.docName)).toEqual([]);
  }, 120_000);

  test('a server-scope reset that asks to keep .okignore is refused and changes nothing, and a plain one clears .okignore', async () => {
    const server = await isolatedServer();
    const local = await bindConfig(server, CONFIG_DOC_NAME_PROJECT_LOCAL, 'project-local');
    expect(local.binding.patch({ search: { semantic: { enabled: true } } }).ok).toBe(true);
    await pollUntil(() => existsSync(localConfigPath(server)), 15_000, 100, 'the local config');
    local.close();
    const okignorePath = join(server.contentDir, '.okignore');
    writeFileSync(okignorePath, 'kept-by-request/\n', 'utf-8');
    await pollUntil(
      () => server.instance.contentFilter.isExcluded('kept-by-request/note.md'),
      15_000,
      100,
      'the .okignore pattern to apply',
    );

    const refused = await fetch(
      `${server.baseUrl}/api/test-reset?scope=server&reset-okignore=false`,
      { method: 'POST' },
    );

    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      type: 'urn:ok:error:invalid-request',
      title:
        'reset-okignore cannot be combined with scope=server: a server-scope reset always restores .okignore.',
    });
    expect(readFileSync(okignorePath, 'utf-8')).toBe('kept-by-request/\n');
    expect(server.instance.contentFilter.isExcluded('kept-by-request/note.md')).toBe(true);
    expect(existsSync(localConfigPath(server))).toBe(true);
    expect(await semanticSearchEnabled(server)).toBe(true);

    expect((await resetServer(server)).status).toBe(200);

    expect(existsSync(okignorePath)).toBe(false);
    expect(server.instance.contentFilter.isExcluded('kept-by-request/note.md')).toBe(false);
    expect(existsSync(localConfigPath(server))).toBe(false);
  }, 60_000);

  test('a project config the next run writes again with the same bytes reaches its consumers after the reset', async () => {
    const server = await isolatedServer();
    const seeded = 'content:\n  attachmentFolderPath: assets\n';
    writeFileSync(projectConfigPath(server), seeded, 'utf-8');
    await pollUntil(
      () => !server.instance.contentFilter.isExcluded('assets/new.png'),
      15_000,
      100,
      'the seeded attachment folder to apply',
    );

    expect((await resetServer(server)).status).toBe(200);
    expect(server.instance.contentFilter.isExcluded('assets/new.png')).toBe(true);
    writeFileSync(projectConfigPath(server), seeded, 'utf-8');

    await pollUntil(
      () => !server.instance.contentFilter.isExcluded('assets/new.png'),
      15_000,
      100,
      'the same attachment folder, written again after the reset, to apply',
    );
    const next = await bindConfig(server, CONFIG_DOC_NAME_PROJECT, 'project');
    expect(next.binding.current().content.attachmentFolderPath).toBe('assets');
  }, 60_000);

  test('an .okignore the next run writes again with the same bytes applies after the reset', async () => {
    const server = await isolatedServer();
    const okignorePath = join(server.contentDir, '.okignore');
    writeFileSync(okignorePath, 'seeded-again/\n', 'utf-8');
    await pollUntil(
      () => server.instance.contentFilter.isExcluded('seeded-again/note.md'),
      15_000,
      100,
      'the seeded .okignore pattern to apply',
    );

    expect((await resetServer(server)).status).toBe(200);
    expect(server.instance.contentFilter.isExcluded('seeded-again/note.md')).toBe(false);
    writeFileSync(okignorePath, 'seeded-again/\n', 'utf-8');

    await pollUntil(
      () => server.instance.contentFilter.isExcluded('seeded-again/note.md'),
      15_000,
      100,
      'the same .okignore pattern, written again after the reset, to apply',
    );
  }, 60_000);

  test('resetting one server leaves another server’s settings, documents and content alone', async () => {
    const reset = await isolatedServer();
    const other = await isolatedServer();
    await saveEverySettingScope(reset);
    await saveEverySettingScope(other);
    const client = await createTestClient(other.port, 'test-doc', { skipInvariantWatcher: true });
    opened.push(() => client.cleanup());
    client.ytext.insert(0, 'live in the other server\n');
    await agentWrite(other, 'agent-notes', 'other server agent\n');
    const otherSettings = [projectConfigPath(other), localConfigPath(other), userConfigPath(other)];
    const settingsBefore = otherSettings.map((path) => readFileSync(path, 'utf-8'));

    expect((await resetServer(reset)).status).toBe(200);

    expect(otherSettings.map((path) => readFileSync(path, 'utf-8'))).toEqual(settingsBefore);
    expect(other.instance.contentFilter.isExcluded('assets/new.png')).toBe(false);
    expect(await semanticSearchEnabled(other)).toBe(true);
    expect(other.instance.hocuspocus.documents.has('test-doc')).toBe(true);
    expect(other.instance.sessionManager.liveSessionCount).toBeGreaterThan(0);
    expect(client.provider.isSynced).toBe(true);
    expect(client.ytext.toString()).toContain('live in the other server');
  }, 120_000);
});
