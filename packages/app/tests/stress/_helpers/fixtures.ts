import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base } from '@playwright/test';
import { resetContentToFixtureBaseline } from './content-reset.ts';
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
import { removeAllDuringTeardown } from './teardown-fs.ts';

export interface WorkerServer {
  pid: number;
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

const APP_WARMUP_GOTO_TIMEOUT_MS = 60_000;
const APP_WARMUP_TIMEOUT_MS = 60_000;

async function warmupAppFirstLoad(
  browser: import('@playwright/test').Browser,
  baseURL: string,
): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${baseURL}/`, { timeout: APP_WARMUP_GOTO_TIMEOUT_MS });
    await page
      .getByRole('treeitem', { name: REQUIRED_FIXTURE_ENTRY_NAMES[0], exact: true })
      .waitFor({ state: 'visible', timeout: APP_WARMUP_TIMEOUT_MS });
  } finally {
    await context.close();
  }
}

export const REQUIRED_FIXTURE_ENTRY_NAMES = ['test-doc.md', 'sidebar-folder'] as const;

const REQUIRED_FIXTURE_DOC_NAMES = ['test-doc', 'sidebar-folder/nested-doc'] as const;

async function waitForSeededPagesSettled(baseURL: string, seededNames: string[]): Promise<void> {
  const missingSet = new Set(seededNames);
  const allowedTopSegments = new Set<string>([
    ...REQUIRED_FIXTURE_DOC_NAMES.map((n) => n.split('/')[0] ?? n),
    ...seededNames.map((n) => n.split('/')[0] ?? n),
  ]);
  const SETTLE_TIMEOUT_MS = 30_000;
  const RESCUE_AFTER_MS = 8_000;
  const started = Date.now();
  let rescued = false;
  let lastState = '(no /api/pages response yet)';
  while (true) {
    const remaining = SETTLE_TIMEOUT_MS - (Date.now() - started);
    if (remaining <= 0) break;
    const res = await fetch(`${baseURL}/api/pages`, {
      signal: AbortSignal.timeout(remaining),
    }).catch((err: unknown) => {
      lastState = `fetch error: ${err instanceof Error ? err.message : String(err)}`;
      return null;
    });
    if (res?.ok) {
      let body: { pages?: Array<{ docName: string }> } | null = null;
      try {
        body = (await res.json()) as { pages?: Array<{ docName: string }> };
      } catch {
        lastState = '/api/pages returned 200 with a non-JSON body';
      }
      if (body) {
        const docNames = (body.pages ?? []).map((p) => p.docName).filter((n) => !n.startsWith('.'));
        const missing = docNames.reduce((set, n) => {
          set.delete(n);
          return set;
        }, new Set(missingSet));
        const extras = docNames.filter((n) => !allowedTopSegments.has(n.split('/')[0] ?? n));
        if (missing.size === 0 && extras.length === 0) return;
        lastState = `missing=[${[...missing].join(', ')}] extras=[${extras.join(', ')}]`;
      }
    }
    if (!rescued && Date.now() - started > RESCUE_AFTER_MS) {
      rescued = true;
      const rescueRes = await fetch(`${baseURL}/api/test-rescan-files`, {
        method: 'POST',
        signal: AbortSignal.timeout(Math.max(1, SETTLE_TIMEOUT_MS - (Date.now() - started))),
      }).catch((err: unknown) => {
        lastState = `rescue-fetch error: ${err instanceof Error ? err.message : String(err)}`;
        return null;
      });
      if (rescueRes && !rescueRes.ok) {
        lastState = `rescue-fetch returned ${rescueRes.status}`;
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(
    `seeded docs did not settle in /api/pages within ${SETTLE_TIMEOUT_MS}ms: ${lastState}`,
  );
}

function seedRequiredFixtureFiles(contentDir: string): void {
  writeFileSync(join(contentDir, 'test-doc.md'), '', 'utf-8');
  mkdirSync(join(contentDir, 'sidebar-folder'), { recursive: true });
  writeFileSync(join(contentDir, 'sidebar-folder', 'nested-doc.md'), '', 'utf-8');
  mkdirSync(join(contentDir, '.claude', 'skills'), { recursive: true });
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  workerServerEnv: [{}, { scope: 'worker', option: true }],
  workerServer: [
    async ({ workerServerEnv, browser }, use, workerInfo) => {
      const port = await getFreePort();
      const contentDir = mkdtempSync(join(tmpdir(), `ok-w${workerInfo.workerIndex}-`));
      const viteCacheDir = prepareViteCacheDir(`w${workerInfo.workerIndex}`);
      seedRequiredFixtureFiles(contentDir);
      const baseURL = `http://127.0.0.1:${port}`;

      const serverLog = openServerLog(`w${workerInfo.workerIndex}`);

      const proc = spawn('pnpm', ['run', 'dev', '--host', '127.0.0.1'], {
        cwd: APP_PACKAGE_ROOT,
        detached: true,
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
        await warmupAppFirstLoad(browser, baseURL);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        try {
          await killGracefully(proc);
        } finally {
          closeServerLog(serverLog);
          removeAllDuringTeardown(contentDir, viteCacheDir);
        }
        throw new Error(
          `${reason}\n--- dev server log tail (${serverLog.path}) ---\n${tailServerLog(serverLog)}`,
        );
      }

      if (proc.pid === undefined) throw new Error('dev server process has no pid');
      await use({ pid: proc.pid, port, baseURL, contentDir });

      try {
        await killGracefully(proc);
      } finally {
        closeServerLog(serverLog);
        removeAllDuringTeardown(serverLog.path, contentDir, viteCacheDir);
      }
    },
    { scope: 'worker', timeout: 240_000 },
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
        await resetContentToFixtureBaseline(baseURL, workerServer.contentDir);
        await helpers.testReset();
        const docNameOf = (name: string) => name.replace(/\.(md|mdx)$/i, '');
        for (const d of docs) {
          await helpers.createPage(/\.(md|mdx)$/i.test(d.name) ? d.name : `${d.name}.md`);
        }
        for (const d of docs) await helpers.replaceDoc(docNameOf(d.name), d.markdown);
        await waitForSeededPagesSettled(
          baseURL,
          docs.map((d) => docNameOf(d.name)),
        );
      },
    };
    await use(helpers);
  },
});

export { expect } from '@playwright/test';
