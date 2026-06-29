
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { type ElectronApplication, _electron as electron } from '@playwright/test';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');
const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';

const YDOC_SETTLE_BUDGET_MS = 15_000;
const YDOC_POLL_INTERVAL_MS = 250;

type Variant = 'same-para' | 'diff-para' | 'mark-overlap' | 'burst' | 'randomized';

interface ProbeOutcome {
  variant: Variant;
  trials: number;
  httpStatusCodes: number[];
  finalContents: string[];
  cherryPresent: boolean[];
  bananaAbsent: boolean[];
  humanXCount: number[];
  raceFired: boolean[]; // 200 OK + agent's CHERRY missing in post-settle Y.Doc
}

const HUMAN_SENTINEL = 'X';
const AGENT_REPLACE = 'CHERRY';

interface ApiPort {
  port: number;
}

async function detectApiPort(page: import('@playwright/test').Page): Promise<ApiPort> {
  const apiOrigin = await page.evaluate(() => window.okDesktop?.config?.apiOrigin);
  if (!apiOrigin) {
    throw new Error(`window.okDesktop.config.apiOrigin was empty (got: ${apiOrigin})`);
  }
  return { port: Number(new URL(apiOrigin).port) };
}

async function fetchYDocContent(port: number, docName: string): Promise<string> {
  const r = await fetch(
    `http://localhost:${port}/api/document?docName=${encodeURIComponent(docName)}`,
  ).catch(() => null);
  if (!r) return '';
  const j = (await r.json().catch(() => ({}))) as { content?: string };
  return j.content ?? '';
}

interface RaceResult {
  httpStatus: number;
  finalContent: string;
  cherryPresent: boolean;
  bananaAbsent: boolean;
  humanXCount: number;
  raceFired: boolean;
}

async function executeRace(opts: {
  page: import('@playwright/test').Page;
  port: number;
  docName: string;
  variant: Variant;
  trial: number;
  randomizedStaggerMs?: number;
}): Promise<RaceResult> {
  const { page, port, docName, variant, trial, randomizedStaggerMs } = opts;

  const seedContent =
    '# Probe\n\nBANANA is here in the first paragraph.\n\nSecond paragraph for diff-para variant.\n';
  expect(seedContent).not.toContain(HUMAN_SENTINEL);
  expect(AGENT_REPLACE).not.toContain(HUMAN_SENTINEL);
  const seedRes = await fetch(`http://localhost:${port}/api/agent-write-md`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      docName,
      markdown: seedContent,
      position: 'replace',
      agentId: `probe-seed`,
      agentName: 'probe-seed',
    }),
  });
  if (!seedRes.ok) {
    throw new Error(`Seed write failed: ${seedRes.status} ${await seedRes.text()}`);
  }

  await expect(
    page.locator('.ProseMirror[contenteditable="true"]:not(.composer-prosemirror)'),
  ).toContainText('BANANA is here', {
    timeout: 10_000,
  });
  let targetPara: import('@playwright/test').Locator;
  if (variant === 'diff-para') {
    targetPara = page
      .locator('.ProseMirror[contenteditable="true"]:not(.composer-prosemirror) p')
      .filter({ hasText: 'Second paragraph' });
  } else {
    targetPara = page
      .locator('.ProseMirror[contenteditable="true"]:not(.composer-prosemirror) p')
      .filter({ hasText: 'BANANA' });
  }
  await targetPara.click();
  await page.keyboard.press('End');

  if (variant === 'mark-overlap') {
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press('Shift+ArrowLeft');
    }
    await page.keyboard.press('Meta+B');
    await page.keyboard.press('End');
    await wait(150);
  }

  const humanText = HUMAN_SENTINEL.repeat(8);
  const typingDelay = variant === 'burst' ? 0 : 5;

  const agentPatchPromise = (): Promise<Response> =>
    fetch(`http://localhost:${port}/api/agent-patch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        docName,
        find: 'BANANA',
        replace: AGENT_REPLACE,
        agentId: trial < 5 ? `probe-${variant}-${trial}` : `probe-${variant}-pool-${trial % 5}`,
        agentName: 'probe',
      }),
    });
  let httpStatus: number;
  if (randomizedStaggerMs !== undefined && randomizedStaggerMs > 0) {
    const firstHalf = humanText.slice(0, 4);
    const secondHalf = humanText.slice(4);
    await page.keyboard.type(firstHalf, { delay: typingDelay });
    await wait(randomizedStaggerMs);
    const [agentRes] = await Promise.all([
      agentPatchPromise(),
      page.keyboard.type(secondHalf, { delay: typingDelay }),
    ]);
    httpStatus = agentRes.status;
  } else {
    const [agentRes] = await Promise.all([
      agentPatchPromise(),
      page.keyboard.type(humanText, { delay: typingDelay }),
    ]);
    httpStatus = agentRes.status;
  }

  let finalContent = '';
  let cherryPresent = false;
  let bananaAbsent = false;
  let humanXCount = 0;
  const deadline = Date.now() + YDOC_SETTLE_BUDGET_MS;
  while (Date.now() < deadline) {
    finalContent = await fetchYDocContent(port, docName);
    cherryPresent = finalContent.includes(AGENT_REPLACE);
    bananaAbsent = !finalContent.includes('BANANA');
    humanXCount = finalContent.split(HUMAN_SENTINEL).length - 1;
    if (cherryPresent && bananaAbsent && humanXCount >= 4) break;
    await wait(YDOC_POLL_INTERVAL_MS);
  }


  const raceFired = httpStatus === 200 && !cherryPresent;
  return {
    httpStatus,
    finalContent,
    cherryPresent,
    bananaAbsent,
    humanXCount,
    raceFired,
  };
}

async function setupElectron(
  variantTag: string,
  captureStderrFor: (app: ElectronApplication) => void,
): Promise<{
  app: ElectronApplication;
  page: import('@playwright/test').Page;
  port: number;
  docName: string;
  contentDir: string;
  userDataDir: string;
}> {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Driver uses macOS open(1).');
  test.skip(!existsSync(MAIN_ENTRY), `out/main/index.js missing — run \`bun run build:desktop\`.`);

  const contentDir = mkdtempSync(join(tmpdir(), `ok-agent-patch-probe-${variantTag}-`));
  const userDataDir = mkdtempSync(join(tmpdir(), `ok-pw-userdata-${variantTag}-`));
  const docName = `probe-${variantTag}-${randomUUID().slice(0, 8)}`;
  const initialContent =
    '# Probe\n\nBANANA is here in the first paragraph.\n\nSecond paragraph for diff-para variant.\n';

  mkdirSync(join(contentDir, '.ok'), { recursive: true });
  writeFileSync(join(contentDir, '.ok', 'config.yml'), 'content:\n  dir: .\n');
  writeFileSync(join(contentDir, `${docName}.md`), initialContent);

  const deepLink = `openknowledge://open?project=${encodeURIComponent(contentDir)}&doc=${encodeURIComponent(docName)}`;

  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, deepLink],
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 30_000,
  });
  captureStderrFor(app);

  const expectedHashSuffix = `#/${docName}`;
  let page: import('@playwright/test').Page | undefined;
  await expect(async () => {
    for (const w of app.windows()) {
      const hash = await w.evaluate(() => window.location.hash).catch(() => '');
      if (hash.endsWith(expectedHashSuffix)) {
        page = w;
        return;
      }
    }
    throw new Error('editor window not yet open');
  }).toPass({ timeout: 30_000 });
  if (!page) throw new Error('editor page not found');
  await page.waitForLoadState('domcontentloaded');
  await expect(
    page.locator('.ProseMirror[contenteditable="true"]:not(.composer-prosemirror)'),
  ).toContainText('BANANA', { timeout: 30_000 });

  const { port } = await detectApiPort(page);

  const beforeContent = await fetchYDocContent(port, docName);
  console.log(
    `[PROBE ${variantTag}] BEFORE — server Y.Doc len=${beforeContent.length}, includes BANANA=${beforeContent.includes('BANANA')}`,
  );
  expect(beforeContent).toContain('BANANA');

  return { app, page, port, docName, contentDir, userDataDir };
}

test.describe('PRD-6666 — agent-patch divergence (production-built Electron)', () => {

  test('Variant A — human types in SAME paragraph as agent find target', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(120_000);
    const { page, port, docName } = await setupElectron('A', captureStderrFor);

    const result = await executeRace({
      page,
      port,
      docName,
      variant: 'same-para',
      trial: 0,
    });
    console.log('[PROBE A] result:', {
      httpStatus: result.httpStatus,
      cherryPresent: result.cherryPresent,
      bananaAbsent: result.bananaAbsent,
      humanXCount: result.humanXCount,
      raceFired: result.raceFired,
      finalLen: result.finalContent.length,
      preview: result.finalContent.slice(0, 200),
    });

    expect(result.httpStatus).toBe(200);
    expect(result.cherryPresent).toBe(true);
    expect(result.bananaAbsent).toBe(true);
    expect(result.humanXCount).toBeGreaterThanOrEqual(4);
    expect(result.raceFired).toBe(false);
  });

  test('Variant B — human types in DIFFERENT paragraph (negative control)', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(120_000);
    const { page, port, docName } = await setupElectron('B', captureStderrFor);

    const result = await executeRace({
      page,
      port,
      docName,
      variant: 'diff-para',
      trial: 0,
    });
    console.log('[PROBE B] result:', {
      httpStatus: result.httpStatus,
      cherryPresent: result.cherryPresent,
      bananaAbsent: result.bananaAbsent,
      humanXCount: result.humanXCount,
      raceFired: result.raceFired,
      finalLen: result.finalContent.length,
      preview: result.finalContent.slice(0, 200),
    });

    expect(result.httpStatus).toBe(200);
    expect(result.cherryPresent).toBe(true);
    expect(result.bananaAbsent).toBe(true);
    expect(result.humanXCount).toBeGreaterThanOrEqual(4);
    expect(result.raceFired).toBe(false);
  });

  test('Variant C — human applies BOLD mark overlapping agent find region', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(120_000);
    const { page, port, docName } = await setupElectron('C', captureStderrFor);

    const result = await executeRace({
      page,
      port,
      docName,
      variant: 'mark-overlap',
      trial: 0,
    });
    console.log('[PROBE C] result:', {
      httpStatus: result.httpStatus,
      cherryPresent: result.cherryPresent,
      bananaAbsent: result.bananaAbsent,
      humanXCount: result.humanXCount,
      raceFired: result.raceFired,
      finalLen: result.finalContent.length,
      preview: result.finalContent.slice(0, 200),
    });

    expect(result.httpStatus).toBe(200);
    expect(result.cherryPresent).toBe(true);
    expect(result.bananaAbsent).toBe(true);
    expect(result.humanXCount).toBeGreaterThanOrEqual(4);
    expect(result.raceFired).toBe(false);
  });

  test('Variant D — BURST typing (no keystroke delay) races agent-patch', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(120_000);
    const { page, port, docName } = await setupElectron('D', captureStderrFor);

    const result = await executeRace({
      page,
      port,
      docName,
      variant: 'burst',
      trial: 0,
    });
    console.log('[PROBE D] result:', {
      httpStatus: result.httpStatus,
      cherryPresent: result.cherryPresent,
      bananaAbsent: result.bananaAbsent,
      humanXCount: result.humanXCount,
      raceFired: result.raceFired,
      finalLen: result.finalContent.length,
      preview: result.finalContent.slice(0, 200),
    });

    expect(result.httpStatus).toBe(200);
    expect(result.cherryPresent).toBe(true);
    expect(result.bananaAbsent).toBe(true);
    expect(result.humanXCount).toBeGreaterThanOrEqual(4);
    expect(result.raceFired).toBe(false);
  });

  test('Variant E — 100-trial randomized stagger race (same-paragraph)', async ({
    captureStderrFor,
  }) => {
    test.setTimeout(15 * 60_000);
    const { page, port, docName } = await setupElectron('E', captureStderrFor);

    const TRIALS = process.env.CI ? 25 : 100;
    const outcomes: ProbeOutcome = {
      variant: 'randomized',
      trials: TRIALS,
      httpStatusCodes: [],
      finalContents: [],
      cherryPresent: [],
      bananaAbsent: [],
      humanXCount: [],
      raceFired: [],
    };
    for (let trial = 0; trial < TRIALS; trial++) {
      const stagger = Math.floor(Math.random() * 10);
      const result = await executeRace({
        page,
        port,
        docName,
        variant: 'same-para',
        trial,
        randomizedStaggerMs: stagger,
      });
      outcomes.httpStatusCodes.push(result.httpStatus);
      outcomes.finalContents.push(result.finalContent);
      outcomes.cherryPresent.push(result.cherryPresent);
      outcomes.bananaAbsent.push(result.bananaAbsent);
      outcomes.humanXCount.push(result.humanXCount);
      outcomes.raceFired.push(result.raceFired);

      if (result.raceFired) {
        console.log(`[PROBE E trial ${trial}] RACE FIRED — stagger=${stagger}ms:`, {
          httpStatus: result.httpStatus,
          finalContent: result.finalContent,
        });
        break;
      }
      if ((trial + 1) % 10 === 0) {
        console.log(`[PROBE E] ${trial + 1}/${TRIALS} trials complete; no race fired so far.`);
      }
    }

    const raceCount = outcomes.raceFired.filter(Boolean).length;
    const cherryMissedCount = outcomes.cherryPresent.filter((c) => !c).length;
    const bananaPresentCount = outcomes.bananaAbsent.filter((a) => !a).length;
    console.log('[PROBE E] aggregate:', {
      totalTrials: outcomes.raceFired.length,
      raceFiredCount: raceCount,
      cherryMissedCount,
      bananaPresentCount,
    });

    expect(raceCount).toBe(0);
    expect(cherryMissedCount).toBe(0);
    expect(bananaPresentCount).toBe(0);
  });
});
