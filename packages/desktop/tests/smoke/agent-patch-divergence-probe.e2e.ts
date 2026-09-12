import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { type ElectronApplication, _electron as electron } from '@playwright/test';
import { desktopLaunchOptions, resolveDesktopTarget } from './_helpers/launch-desktop';
import { PLATFORM_SKIP_REASON, PLATFORM_SUPPORTED, SMOKE_ENABLED } from './_helpers/platform-gate';
import { waitForEditorSelection } from './_helpers/settings-surface';
import { expect, test } from './_helpers/smoke-test';

const TARGET = resolveDesktopTarget();

const YDOC_SETTLE_BUDGET_MS = 15_000;
const YDOC_POLL_INTERVAL_MS = 250;

type Variant = 'same-para' | 'diff-para' | 'mark-overlap' | 'burst';

interface ProbeOutcome {
  cherryPresent: boolean[];
  bananaAbsent: boolean[];
  raceFired: boolean[];
  readFailures: string[][];
  sawSuccessfulRead: boolean[];
  lastReadSucceeded: boolean[];
}

const HUMAN_SENTINEL = 'X';
const HUMAN_TYPED_COUNT = 8;
const AGENT_REPLACE = 'CHERRY';
const AGENT_FIND = 'BANANA';
const FIRST_PARAGRAPH = `${AGENT_FIND} is here in the first paragraph.`;
const SECOND_PARAGRAPH = 'Second paragraph for diff-para variant.';
const SEED_MARKDOWN = `# Probe\n\n${FIRST_PARAGRAPH}\n\n${SECOND_PARAGRAPH}\n`;
const SELECTION_SETTLE_MS = 3_000;
const BOLD_RUN_OVER_REPLACED_FIND = `**${FIRST_PARAGRAPH.replace(AGENT_FIND, AGENT_REPLACE)}${HUMAN_SENTINEL.repeat(HUMAN_TYPED_COUNT)}**`;

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

interface YDocRead {
  content: string;
  readFailure: string | null;
}

async function fetchYDocContent(port: number, docName: string): Promise<YDocRead> {
  let res: Response;
  try {
    res = await fetch(
      `http://localhost:${port}/api/document?docName=${encodeURIComponent(docName)}`,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { content: '', readFailure: `fetch rejected: ${detail}` };
  }
  const raw = await res.text().catch(() => null);
  if (raw === null) return { content: '', readFailure: `HTTP ${res.status}: body unreadable` };
  if (!res.ok) return { content: '', readFailure: `HTTP ${res.status}: ${raw.slice(0, 160)}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { content: '', readFailure: `unparsable JSON body: ${raw.slice(0, 160)}` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { content: '', readFailure: `non-object JSON body: ${raw.slice(0, 160)}` };
  }
  const content = (parsed as { content?: unknown }).content;
  if (typeof content !== 'string') {
    return { content: '', readFailure: `no string content field: ${raw.slice(0, 160)}` };
  }
  return { content, readFailure: null };
}

interface SettleState {
  cherryPresent: boolean;
  bananaAbsent: boolean;
  humanXCount: number;
  settled: boolean;
}

function readSettleState(variant: Variant, content: string): SettleState {
  const cherryPresent = content.includes(AGENT_REPLACE);
  const bananaAbsent = !content.includes(AGENT_FIND);
  const humanXCount = content.split(HUMAN_SENTINEL).length - 1;
  const markSettled = variant !== 'mark-overlap' || content.includes(BOLD_RUN_OVER_REPLACED_FIND);
  return {
    cherryPresent,
    bananaAbsent,
    humanXCount,
    settled: cherryPresent && bananaAbsent && humanXCount >= 4 && markSettled,
  };
}

interface RaceResult {
  httpStatus: number;
  finalContent: string;
  settled: boolean;
  readFailures: string[];
  sawSuccessfulRead: boolean;
  lastReadSucceeded: boolean;
  cherryPresent: boolean;
  bananaAbsent: boolean;
  humanXCount: number;
  raceFired: boolean;
}

async function resolveLeftoverConflict(port: number, docName: string): Promise<void> {
  const file = docName.endsWith('.md') ? docName : `${docName}.md`;
  const res = await fetch(`http://localhost:${port}/api/sync/resolve-conflict`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file, strategy: 'mine' }),
  }).catch(() => null);
  if (!res) return;
  if (res.ok || res.status === 404 || res.status === 503) return;
}

async function seedProbeDocument(port: number, docName: string, markdown: string): Promise<void> {
  await resolveLeftoverConflict(port, docName);
  for (let attempt = 0; attempt < 3; attempt++) {
    const seedRes = await fetch(`http://localhost:${port}/api/agent-write-md`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        docName,
        markdown,
        position: 'replace',
        agentId: 'probe-seed',
        agentName: 'probe-seed',
      }),
    });
    if (seedRes.ok) return;
    if (seedRes.status === 409 && attempt < 2) {
      await resolveLeftoverConflict(port, docName);
      await wait(250);
      continue;
    }
    throw new Error(`Seed write failed: ${seedRes.status} ${await seedRes.text()}`);
  }
}

async function selectWholeParagraph(
  targetPara: import('@playwright/test').Locator,
  page: import('@playwright/test').Page,
  paragraph: string,
  timeoutMs = 30_000,
): Promise<void> {
  await expect(async () => {
    await targetPara.click({ clickCount: 3 });
    await waitForEditorSelection(page, paragraph, SELECTION_SETTLE_MS);
  }).toPass({ timeout: timeoutMs });
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

  const seedContent = SEED_MARKDOWN;
  expect(seedContent).not.toContain(HUMAN_SENTINEL);
  expect(AGENT_REPLACE).not.toContain(HUMAN_SENTINEL);
  await seedProbeDocument(port, docName, seedContent);

  const editor = page.locator('.ProseMirror[contenteditable="true"]:not(.composer-prosemirror)');
  await editor.waitFor({ state: 'visible', timeout: 10_000 });
  await expect(editor).toContainText(FIRST_PARAGRAPH, {
    timeout: 10_000,
  });
  let targetPara: import('@playwright/test').Locator;
  if (variant === 'diff-para') {
    targetPara = page
      .locator('.ProseMirror[contenteditable="true"]:not(.composer-prosemirror) p')
      .filter({ hasText: SECOND_PARAGRAPH });
  } else {
    targetPara = page
      .locator('.ProseMirror[contenteditable="true"]:not(.composer-prosemirror) p')
      .filter({ hasText: AGENT_FIND });
  }
  await targetPara.click();
  await page.keyboard.press('End');

  if (variant === 'mark-overlap') {
    await selectWholeParagraph(targetPara, page, FIRST_PARAGRAPH);
    await page.keyboard.press('ControlOrMeta+B');
    await page.keyboard.press('End');
    await wait(150);
  }

  const humanText = HUMAN_SENTINEL.repeat(HUMAN_TYPED_COUNT);
  const typingDelay = variant === 'burst' ? 0 : 5;

  const agentPatchPromise = (): Promise<Response> =>
    fetch(`http://localhost:${port}/api/agent-patch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        docName,
        find: AGENT_FIND,
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
  const readFailures: string[] = [];
  let sawSuccessfulRead = false;
  let lastReadSucceeded = false;
  let cherryPresent = false;
  let bananaAbsent = false;
  let humanXCount = 0;
  const deadline = Date.now() + YDOC_SETTLE_BUDGET_MS;
  while (Date.now() < deadline) {
    const read = await fetchYDocContent(port, docName);
    if (read.readFailure !== null) {
      readFailures.push(read.readFailure);
      lastReadSucceeded = false;
    } else {
      sawSuccessfulRead = true;
      lastReadSucceeded = true;
      finalContent = read.content;
      const settleState = readSettleState(variant, finalContent);
      cherryPresent = settleState.cherryPresent;
      bananaAbsent = settleState.bananaAbsent;
      humanXCount = settleState.humanXCount;
      if (settleState.settled) break;
    }
    await wait(YDOC_POLL_INTERVAL_MS);
  }

  const raceFired = lastReadSucceeded && httpStatus === 200 && !cherryPresent;
  return {
    httpStatus,
    finalContent,
    settled: lastReadSucceeded && readSettleState(variant, finalContent).settled,
    readFailures,
    sawSuccessfulRead,
    lastReadSucceeded,
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
  test.skip(!PLATFORM_SUPPORTED, PLATFORM_SKIP_REASON);
  test.skip(!TARGET.exists, TARGET.missingReason);

  const contentDir = mkdtempSync(join(tmpdir(), `ok-agent-patch-probe-${variantTag}-`));
  const userDataDir = mkdtempSync(join(tmpdir(), `ok-pw-userdata-${variantTag}-`));
  const docName = `probe-${variantTag}-${randomUUID().slice(0, 8)}`;
  const initialContent = SEED_MARKDOWN;

  mkdirSync(join(contentDir, '.ok'), { recursive: true });
  writeFileSync(join(contentDir, '.ok', 'config.yml'), 'content:\n  dir: .\n');
  writeFileSync(join(contentDir, `${docName}.md`), initialContent);

  const deepLink = `openknowledge://open?project=${encodeURIComponent(contentDir)}&doc=${encodeURIComponent(docName)}`;

  const app = await electron.launch(
    desktopLaunchOptions({
      target: TARGET,
      args: [`--user-data-dir=${userDataDir}`, deepLink],
      env: { ...process.env, NODE_ENV: 'production' },
      timeout: 30_000,
    }),
  );
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
  ).toContainText(AGENT_FIND, { timeout: 30_000 });

  const { port } = await detectApiPort(page);

  const before = await fetchYDocContent(port, docName);
  console.log(
    `[PROBE ${variantTag}] BEFORE — server Y.Doc len=${before.content.length}, includes ${AGENT_FIND}=${before.content.includes(AGENT_FIND)}, readFailure=${before.readFailure ?? 'none'}`,
  );
  expect(before.readFailure).toBeNull();
  expect(before.content).toContain(AGENT_FIND);

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
      readFailures: result.readFailures,
      sawSuccessfulRead: result.sawSuccessfulRead,
      lastReadSucceeded: result.lastReadSucceeded,
      cherryPresent: result.cherryPresent,
      bananaAbsent: result.bananaAbsent,
      humanXCount: result.humanXCount,
      raceFired: result.raceFired,
      finalLen: result.finalContent.length,
      preview: result.finalContent.slice(0, 200),
    });

    expect(result.sawSuccessfulRead).toBe(true);
    expect(result.lastReadSucceeded).toBe(true);
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
      readFailures: result.readFailures,
      sawSuccessfulRead: result.sawSuccessfulRead,
      lastReadSucceeded: result.lastReadSucceeded,
      cherryPresent: result.cherryPresent,
      bananaAbsent: result.bananaAbsent,
      humanXCount: result.humanXCount,
      raceFired: result.raceFired,
      finalLen: result.finalContent.length,
      preview: result.finalContent.slice(0, 200),
    });

    expect(result.sawSuccessfulRead).toBe(true);
    expect(result.lastReadSucceeded).toBe(true);
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
      readFailures: result.readFailures,
      sawSuccessfulRead: result.sawSuccessfulRead,
      lastReadSucceeded: result.lastReadSucceeded,
      cherryPresent: result.cherryPresent,
      bananaAbsent: result.bananaAbsent,
      humanXCount: result.humanXCount,
      raceFired: result.raceFired,
      finalLen: result.finalContent.length,
      preview: result.finalContent.slice(0, 200),
      expectedBoldRun: BOLD_RUN_OVER_REPLACED_FIND,
    });

    expect(result.sawSuccessfulRead).toBe(true);
    expect(result.lastReadSucceeded).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.cherryPresent).toBe(true);
    expect(result.bananaAbsent).toBe(true);
    expect(result.humanXCount).toBeGreaterThanOrEqual(4);
    expect(result.raceFired).toBe(false);
    expect(result.finalContent).toContain(BOLD_RUN_OVER_REPLACED_FIND);
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
      readFailures: result.readFailures,
      sawSuccessfulRead: result.sawSuccessfulRead,
      lastReadSucceeded: result.lastReadSucceeded,
      cherryPresent: result.cherryPresent,
      bananaAbsent: result.bananaAbsent,
      humanXCount: result.humanXCount,
      raceFired: result.raceFired,
      finalLen: result.finalContent.length,
      preview: result.finalContent.slice(0, 200),
    });

    expect(result.sawSuccessfulRead).toBe(true);
    expect(result.lastReadSucceeded).toBe(true);
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
      cherryPresent: [],
      bananaAbsent: [],
      raceFired: [],
      readFailures: [],
      sawSuccessfulRead: [],
      lastReadSucceeded: [],
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
      outcomes.cherryPresent.push(result.cherryPresent);
      outcomes.bananaAbsent.push(result.bananaAbsent);
      outcomes.raceFired.push(result.raceFired);
      outcomes.readFailures.push(result.readFailures);
      outcomes.sawSuccessfulRead.push(result.sawSuccessfulRead);
      outcomes.lastReadSucceeded.push(result.lastReadSucceeded);

      if (!result.settled || !result.sawSuccessfulRead || result.raceFired) {
        console.log(`[PROBE E trial ${trial}] ANOMALY — stagger=${stagger}ms:`, {
          httpStatus: result.httpStatus,
          sawSuccessfulRead: result.sawSuccessfulRead,
          lastReadSucceeded: result.lastReadSucceeded,
          raceFired: result.raceFired,
          cherryPresent: result.cherryPresent,
          bananaAbsent: result.bananaAbsent,
          humanXCount: result.humanXCount,
          readFailures: result.readFailures,
          finalLen: result.finalContent.length,
          preview: result.finalContent.slice(0, 200),
        });
      }

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

    const readFailures = outcomes.readFailures.flat();
    const trialsWithoutARead = outcomes.sawSuccessfulRead.filter((seen) => !seen).length;
    const trialsEndingOnAFailedRead = outcomes.lastReadSucceeded.filter((ok) => !ok).length;
    const raceCount = outcomes.raceFired.filter(Boolean).length;
    const cherryMissedCount = outcomes.cherryPresent.filter((c) => !c).length;
    const bananaPresentCount = outcomes.bananaAbsent.filter((a) => !a).length;
    console.log('[PROBE E] aggregate:', {
      totalTrials: outcomes.raceFired.length,
      raceFiredCount: raceCount,
      cherryMissedCount,
      bananaPresentCount,
      trialsWithoutARead,
      trialsEndingOnAFailedRead,
      readFailures,
    });

    expect(trialsWithoutARead).toBe(0);
    expect(trialsEndingOnAFailedRead).toBe(0);
    expect(raceCount).toBe(0);
    expect(cherryMissedCount).toBe(0);
    expect(bananaPresentCount).toBe(0);
  });
});
