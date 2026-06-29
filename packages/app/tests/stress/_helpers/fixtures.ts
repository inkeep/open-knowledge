
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base } from '@playwright/test';
import {
  APP_PACKAGE_ROOT,
  checkCollabSync,
  closeServerLog,
  getFreePort,
  killGracefully,
  openServerLog,
  prepareViteCacheDir,
  tailServerLog,
  waitForHttpReady,
} from './server-process.ts';

export interface WorkerServer {
  port: number;
  baseURL: string;
  contentDir: string;
}

export interface AgentIdentity {
  agentId: string;
  agentName: string;
  clientName?: string;
  colorSeed?: string;
}

export interface ApiHelpers {
  createPage(path: string): Promise<void>;
  replaceDoc(docName: string, markdown: string): Promise<void>;
  writeAsAgent(docName: string, markdown: string, identity: AgentIdentity): Promise<void>;
  testReset(docName?: string): Promise<void>;
  seedDocs(docs: Array<{ name: string; markdown: string }>): Promise<void>;
}

type WorkerFixtures = {
  workerServer: WorkerServer;
  workerServerEnv: Record<string, string>;
};

type TestFixtures = {
  api: ApiHelpers;
};

async function checkApiConfig(baseURL: string, timeoutMs = 2_000): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${baseURL}/api/config`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`/api/config did not respond within ${timeoutMs}ms: ${String(err)}`);
  }
  if (res.status !== 200) {
    throw new Error(`/api/config returned status ${res.status}, expected 200`);
  }
  let body: {
    collabUrl?: unknown;
    previewUrl?: unknown;
    port?: unknown;
  } | null;
  try {
    body = (await res.json()) as typeof body;
  } catch (parseErr) {
    throw new Error(`/api/config returned 200 but body is not valid JSON: ${String(parseErr)}`);
  }
  if (
    !body ||
    typeof body.port !== 'number' ||
    (typeof body.collabUrl !== 'string' && body.collabUrl !== null)
  ) {
    throw new Error(`/api/config returned unexpected body shape: ${JSON.stringify(body)}`);
  }
}

async function waitForServerReady(baseURL: string, port: number): Promise<void> {
  await waitForHttpReady(baseURL, 60_000);
  await checkApiConfig(baseURL);
  await checkCollabSync(port);
}

export const REQUIRED_FIXTURE_ENTRY_NAMES = ['test-doc.md', 'sidebar-folder'] as const;

function seedRequiredFixtureFiles(contentDir: string): void {
  writeFileSync(join(contentDir, 'test-doc.md'), '', 'utf-8');
  mkdirSync(join(contentDir, 'sidebar-folder'), { recursive: true });
  writeFileSync(join(contentDir, 'sidebar-folder', 'nested-doc.md'), '', 'utf-8');
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  workerServerEnv: [{}, { scope: 'worker', option: true }],
  workerServer: [
    async ({ workerServerEnv }, use, workerInfo) => {
      const port = await getFreePort();
      const contentDir = mkdtempSync(join(tmpdir(), `ok-w${workerInfo.workerIndex}-`));
      const viteCacheDir = prepareViteCacheDir(`w${workerInfo.workerIndex}`);
      seedRequiredFixtureFiles(contentDir);
      const baseURL = `http://127.0.0.1:${port}`;

      const serverLog = openServerLog(`w${workerInfo.workerIndex}`);

      const proc = spawn('bun', ['run', '--silent', 'dev', '--host', '127.0.0.1'], {
        cwd: APP_PACKAGE_ROOT,
        env: {
          ...process.env,
          ...workerServerEnv,
          VITE_PORT: String(port),
          OK_TEST_CONTENT_DIR: contentDir,
          OK_TEST_VITE_CACHE_DIR: viteCacheDir,
          OK_TEST_SKIP_I18N_COMPILE: '1',
          OK_TEST_GIT_ENABLED: '1',
          NO_COLOR: process.env.NO_COLOR ?? '1',
        },
        stdio: ['ignore', serverLog.fd, 'inherit'],
      });

      proc.on('error', (err) => {
        console.error(`[fixture w${workerInfo.workerIndex}] spawn error:`, err);
      });

      try {
        await waitForServerReady(baseURL, port);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        try {
          await killGracefully(proc);
        } finally {
          closeServerLog(serverLog);
          rmSync(contentDir, { recursive: true, force: true });
          rmSync(viteCacheDir, { recursive: true, force: true });
        }
        throw new Error(
          `${reason}\n--- dev server log tail (${serverLog.path}) ---\n${tailServerLog(serverLog)}`,
        );
      }

      await use({ port, baseURL, contentDir });

      try {
        await killGracefully(proc);
      } finally {
        closeServerLog(serverLog);
        rmSync(serverLog.path, { force: true });
        rmSync(contentDir, { recursive: true, force: true });
        rmSync(viteCacheDir, { recursive: true, force: true });
      }
    },
    { scope: 'worker', timeout: 120_000 },
  ],

  baseURL: async ({ workerServer }, use) => {
    await use(workerServer.baseURL);
  },

  api: async ({ workerServer }, use) => {
    const { baseURL } = workerServer;
    const API_CALL_TIMEOUT_MS = 30_000;
    async function post(path: string, body?: unknown): Promise<Response> {
      try {
        return await fetch(`${baseURL}${path}`, {
          method: 'POST',
          ...(body !== undefined
            ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
            : {}),
          signal: AbortSignal.timeout(API_CALL_TIMEOUT_MS),
        });
      } catch (err) {
        const name = (err as { name?: string })?.name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new Error(
            `POST ${path} timed out after ${API_CALL_TIMEOUT_MS}ms — server stalled mid-test (port ${workerServer.port})`,
          );
        }
        throw err;
      }
    }
    const helpers: ApiHelpers = {
      async createPage(path: string): Promise<void> {
        const res = await post('/api/create-page', { path });
        if (res.status === 409) return;
        if (!res.ok) {
          throw new Error(`create-page failed for ${path}: ${res.status}`);
        }
      },
      async replaceDoc(docName: string, markdown: string): Promise<void> {
        const res = await post('/api/agent-write-md', { docName, markdown, position: 'replace' });
        if (!res.ok) {
          throw new Error(`agent-write-md failed for ${docName}: ${res.status}`);
        }
      },
      async writeAsAgent(docName: string, markdown: string, identity): Promise<void> {
        const res = await post('/api/agent-write-md', {
          docName,
          markdown,
          position: 'replace',
          agentId: identity.agentId,
          agentName: identity.agentName,
          clientName: identity.clientName,
          colorSeed: identity.colorSeed,
        });
        if (!res.ok) {
          throw new Error(
            `writeAsAgent failed for ${docName} / ${identity.agentId}: ${res.status}`,
          );
        }
      },
      async testReset(docName?: string): Promise<void> {
        const res = await post(
          docName ? `/api/test-reset?docName=${encodeURIComponent(docName)}` : '/api/test-reset',
        );
        if (!res.ok) {
          throw new Error(`test-reset failed${docName ? ` for ${docName}` : ''}: ${res.status}`);
        }
      },
      async seedDocs(docs: Array<{ name: string; markdown: string }>): Promise<void> {
        await helpers.testReset();
        for (const d of docs) await helpers.createPage(`${d.name}.md`);
        for (const d of docs) await helpers.replaceDoc(d.name, d.markdown);
      },
    };
    await use(helpers);
  },
});

export { expect } from '@playwright/test';
