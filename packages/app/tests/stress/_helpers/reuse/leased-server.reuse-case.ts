import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HocuspocusProvider } from '@hocuspocus/provider';
import {
  bindConfigDoc,
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_PROJECT_LOCAL,
  CONFIG_DOC_NAME_USER,
  type ConfigBinding,
  ConfigSchema,
  type WriteScope,
} from '@inkeep/open-knowledge-core';
import { expect } from '@playwright/test';
import * as Y from 'yjs';
import { test, type WorkerServer } from '../fixtures.ts';
import { REUSE_SOCKET_ENV } from './lease-protocol.ts';
import { CASE_SERVER_ANNOTATION } from './reuse-run.test-helper.ts';
import { connectLeaseClient } from './supervisor-socket.ts';

const STORAGE_PROBE_KEY = 'ok-reuse-probe';
const CREATED_PAGE = 'reuse-created';
const CREATED_FOLDER_PAGE = 'sidebar-folder/reuse-created-inside';
const NESTED_FIXTURE = 'sidebar-folder/nested-doc';
const SETTING_SCOPES = [
  { docName: CONFIG_DOC_NAME_PROJECT, scope: 'project', file: ['.ok', 'config.yml'] },
  {
    docName: CONFIG_DOC_NAME_PROJECT_LOCAL,
    scope: 'project-local',
    file: ['.ok', 'local', 'config.yml'],
  },
  { docName: CONFIG_DOC_NAME_USER, scope: 'user', file: ['.ok', 'global.yml'] },
] as const satisfies ReadonlyArray<{ docName: string; scope: WriteScope; file: readonly string[] }>;

async function withConfigBinding<T>(
  server: WorkerServer,
  docName: string,
  scope: WriteScope,
  use: (binding: ConfigBinding) => Promise<T>,
): Promise<T> {
  const document = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${server.port}/collab`,
    name: docName,
    document,
  });
  const binding = bindConfigDoc(provider, scope);
  try {
    await expect.poll(() => binding.hasSynced()).toBe(true);
    return await use(binding);
  } finally {
    binding.dispose();
    provider.destroy();
    document.destroy();
  }
}

async function pageDocNames(server: WorkerServer): Promise<string[]> {
  const response = await fetch(`${server.baseURL}/api/pages`);
  const body = (await response.json()) as { pages: Array<{ docName: string }> };
  return body.pages.map((page) => page.docName);
}

test('a leased worker server serves the app', async ({ page, workerServer }) => {
  test.info().annotations.push({ type: CASE_SERVER_ANNOTATION, description: workerServer.baseURL });
  await page.goto(`${workerServer.baseURL}/`);
  await expect(page.getByRole('treeitem', { name: 'test-doc.md', exact: true })).toBeVisible();
});

test('a run leaves settings, content, agent state and browser storage behind', async ({
  page,
  workerServer,
  api,
}) => {
  test.info().annotations.push({ type: CASE_SERVER_ANNOTATION, description: workerServer.baseURL });
  const patches = {
    project: { content: { attachmentFolderPath: 'assets' } },
    'project-local': { search: { semantic: { enabled: true } } },
    user: { appearance: { theme: 'dark' } },
  } as const;
  for (const { docName, scope, file } of SETTING_SCOPES) {
    await withConfigBinding(workerServer, docName, scope, async (binding) => {
      expect(binding.patch(patches[scope]).ok).toBe(true);
      await expect.poll(() => existsSync(join(workerServer.contentDir, ...file))).toBe(true);
    });
  }
  await api.createPage(`${CREATED_PAGE}.md`);
  await api.writeAsAgent(CREATED_PAGE, '# left by an earlier run\n', {
    agentId: 'reuse-probe',
    agentName: 'Reuse probe',
    clientName: 'reuse-probe',
    colorSeed: 'reuse-probe',
  });
  await api.replaceDoc('test-doc', 'edited by an earlier run\n');
  await api.createPage(`${CREATED_FOLDER_PAGE}.md`);
  await api.replaceDoc(NESTED_FIXTURE, 'edited by an earlier run\n');
  await page.goto(`${workerServer.baseURL}/`);
  await page.evaluate((key) => localStorage.setItem(key, 'from an earlier run'), STORAGE_PROBE_KEY);
  expect(await pageDocNames(workerServer)).toEqual(
    expect.arrayContaining([CREATED_PAGE, CREATED_FOLDER_PAGE]),
  );
});

test('a later run finds none of an earlier run’s settings, content or browser storage', async ({
  page,
  workerServer,
}) => {
  test.info().annotations.push({ type: CASE_SERVER_ANNOTATION, description: workerServer.baseURL });
  const defaults = ConfigSchema.parse({});
  for (const { docName, scope, file } of SETTING_SCOPES) {
    expect(existsSync(join(workerServer.contentDir, ...file)), file.join('/')).toBe(false);
    await withConfigBinding(workerServer, docName, scope, async (binding) => {
      expect(binding.current(), docName).toEqual(defaults);
    });
  }
  const pages = await pageDocNames(workerServer);
  expect(pages).toContain(NESTED_FIXTURE);
  expect(pages).not.toContain(CREATED_PAGE);
  expect(pages).not.toContain(CREATED_FOLDER_PAGE);
  await page.goto(`${workerServer.baseURL}/`);
  await expect(page.getByRole('treeitem', { name: 'test-doc.md', exact: true })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: `${CREATED_PAGE}.md` })).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_PROBE_KEY)).toBeNull();
  for (const docName of ['test-doc', NESTED_FIXTURE]) {
    const response = await fetch(
      `${workerServer.baseURL}/api/document?docName=${encodeURIComponent(docName)}`,
    );
    expect(((await response.json()) as { content: string }).content, docName).toBe('');
  }
});

test('a run leaves server state that no reset can account for', async ({ workerServer }) => {
  test.info().annotations.push({ type: CASE_SERVER_ANNOTATION, description: workerServer.baseURL });
  writeFileSync(join(workerServer.contentDir, '.ok', 'local', 'unrecognised-state.json'), '{}\n');
});

test('the supervisor shuts down while a test holds its lease', async ({ workerServer }) => {
  const socketPath = process.env[REUSE_SOCKET_ENV];
  if (socketPath === undefined) throw new Error(`${REUSE_SOCKET_ENV} is required`);
  expect((await fetch(`${workerServer.baseURL}/api/config`)).status).toBe(200);
  const client = await connectLeaseClient(socketPath, 5_000);
  try {
    await client.shutdown(60_000);
  } finally {
    client.close();
  }
  const supervisorState = async () => {
    try {
      (await connectLeaseClient(socketPath, 1_000)).close();
      return 'serving';
    } catch {
      return 'gone';
    }
  };
  await expect.poll(supervisorState).toBe('gone');
});

test('a later test of the run whose supervisor shut down', async ({ workerServer }) => {
  test.info().annotations.push({ type: CASE_SERVER_ANNOTATION, description: workerServer.baseURL });
});
