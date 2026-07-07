/**
 * agent-patch divergence probe (production-built Electron).
 *
 * What this guards: `handleAgentPatch` (api-extension.ts) must produce
 * a converged Y.Doc that contains the agent's intended `replace` bytes AND
 * the human's concurrent typing — never a hybrid state where the agent's
 * write was silently dropped while the HTTP response returned 200. The
 * reporter's bug shape is: `find: "BANANA"` returns 200 OK, but the final
 * Y.Doc still contains "BANANA" + the human's typed characters; the
 * agent's CHERRY replacement is silently lost.
 *
 *
 * A structurally identical in-process methodology previously missed a bug
 * that reproduced ONLY in production-built Electron with the minified
 * renderer; the dev (Vite) renderer's slower reconnect timing missed the
 * race entirely. This probe is the equivalent of
 * `rename-divergence-probe.e2e.ts` — production-built Electron, real
 * TipTap → PM → y-prosemirror dispatch, bounded-poll assertions against the
 * server Y.Doc.
 *
 * Five variants exercise the agent-patch surface against concurrent human
 * typing in production-built Electron. A, B, C are categorical: same-
 * paragraph (the reporter's exact case), different-paragraph (negative
 * control — reporter says this works), and mark-overlap (the
 * `updateYFragment`/`updateYText` simpleDiff path). D exercises burst
 * typing without keystroke delay (different y-prosemirror batching
 * cadence). E is a randomized stagger race against the same-paragraph
 * variant (100 trials locally, 25 under CI).
 *
 * Bounded-poll discipline (mirrors the rename probe): false-RED safe,
 * never false-GREEN. If the agent's `replace` never reaches the Y.Doc,
 * the marker never appears and the assertion fails after the budget.
 *
 * Skip conditions mirror the existing smoke tests (smoke-gated, darwin-
 * only, build-must-exist).
 */

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

// Bounded budget to poll the server Y.Doc for the converged post-race state.
// A fixed sleep risks a false-RED on a slow runner but never a false-GREEN:
// if the bug fires, the agent's `replace` byte sequence never reaches the
// Y.Doc, so the polling loop times out and the assertion fails red.
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

// The human types HUMAN_SENTINEL repeated; `humanXCount` tallies how many
// survive the concurrent agent write doc-wide. That doc-wide count is an
// unambiguous tally of human keystrokes only if neither the seed nor the
// agent's replacement token contains the sentinel — guarded at the seed below.
// Keep this a single character: the >= 4-of-8 bound is a CRDT-reorder-tolerant
// count of INDEPENDENT chars, so a multi-char token would be less tolerant (a
// dropped char breaks the whole token).
const HUMAN_SENTINEL = 'X';
const AGENT_REPLACE = 'CHERRY';

interface ApiPort {
  port: number;
}

async function detectApiPort(page: import('@playwright/test').Page): Promise<ApiPort> {
  // Read the API origin straight from the renderer's own config — the canonical
  // value the app's production code uses (`window.okDesktop.config.apiOrigin`,
  // shared/bridge-contract.ts), the exact same string the `--ok-api-origin=`
  // process argv carries. Callers await an editor-content gate first, so the
  // renderer (hence config) is already live; no poll needed. This drops the
  // `ps` parse + the macOS /tmp basename hack + argv-truncation / multi-Helper
  // failure modes. (Editor windows always carry a real origin; Navigator
  // windows expose '' — guarded below, though the probe never drives one.)
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

/**
 * Execute ONE race trial against the live Electron editor.
 *
 * Returns the converged outcome plus the four invariant flags used for the
 * top-level assertion. raceFired === true means "HTTP 200 returned but the
 * agent's CHERRY is missing in the post-settle Y.Doc" — that IS the bug.
 */
async function executeRace(opts: {
  page: import('@playwright/test').Page;
  port: number;
  docName: string;
  variant: Variant;
  trial: number;
  randomizedStaggerMs?: number;
}): Promise<RaceResult> {
  const { page, port, docName, variant, trial, randomizedStaggerMs } = opts;

  // Reset the doc to the canonical pre-race state via agent-write-md replace.
  // This is the only reliable way to make each trial independent — typing
  // accumulates state from the previous trial in the same editor session.
  const seedContent =
    '# Probe\n\nBANANA is here in the first paragraph.\n\nSecond paragraph for diff-para variant.\n';
  // Collision guard: humanXCount below counts HUMAN_SENTINEL doc-wide over the
  // converged content, so it tallies only human keystrokes when neither the
  // seed nor the agent's replacement contains the sentinel. Fail loud if a
  // future content change reintroduces the bare-char ambiguity.
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

  // Wait for the editor to reflect the seeded state before driving keystrokes.
  await expect(
    page.locator('.ProseMirror[contenteditable="true"]:not(.composer-prosemirror)'),
  ).toContainText('BANANA is here', {
    timeout: 10_000,
  });
  // No fixed settle here: the awaited toContainText above already proves the
  // seed converged through the full server -> Y.Text -> XmlFragment -> DOM
  // chain (so the editor is ready for keystrokes), and the targetPara.click()
  // below auto-waits actionability.
  // Position the cursor in the target paragraph (variant-dependent).
  // For all variants except diff-para, click into the paragraph containing
  // BANANA. For diff-para, click into the second paragraph.
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

  // For mark-overlap: select a span overlapping BANANA and apply bold via
  // the keyboard shortcut Cmd+B. This creates a Y.XmlText with a strong
  // mark whose simpleDiff window MAY shift when the agent's replace lands.
  if (variant === 'mark-overlap') {
    // Select from end-of-line backward by 16 chars (covers "is here in the f"
    // — overlaps the BANANA paragraph's content but NOT the BANANA word
    // itself, so the agent's find still matches).
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press('Shift+ArrowLeft');
    }
    await page.keyboard.press('Meta+B');
    // Deselect, return to end of paragraph.
    await page.keyboard.press('End');
    // Let the bold-mark update propagate.
    await wait(150);
  }

  // Kick off the race. The human's typing returns a Promise that resolves
  // when all keystrokes have been emitted; we fire the agent-patch fetch
  // concurrently with Promise.all so both arrive at the server in
  // overlapping time windows.
  const humanText = HUMAN_SENTINEL.repeat(8);
  const typingDelay = variant === 'burst' ? 0 : 5;

  // Optional pre-stagger (E variant) — fires keystrokes BEFORE the agent
  // POST by N ms so the server sees a known mix of pre-arrived and in-flight
  // characters when the agent's transact opens.
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

  // Bounded poll for the converged state. Exits as soon as we observe both
  // CHERRY-present AND BANANA-absent AND at least 4 of the 8 X's present
  // (lower bound for human bytes — CRDT can re-order). On the bug path,
  // CHERRY never appears (agent's write silently dropped) so we time out
  // with the BANANA-still-present state and the assertion fails RED.
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
    // Exit early on full convergence to keep happy-path fast.
    if (cherryPresent && bananaAbsent && humanXCount >= 4) break;
    await wait(YDOC_POLL_INTERVAL_MS);
  }

  // For diff-para, the agent's CHERRY should still land (BANANA was in a
  // different paragraph from the typing). humanXCount is measured in the
  // OTHER paragraph here, but the regex is doc-wide so the count is the
  // same total.

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

  // Find the editor window by hash.
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

  // Sanity check: server Y.Doc has the seeded content before any race.
  const beforeContent = await fetchYDocContent(port, docName);
  console.log(
    `[PROBE ${variantTag}] BEFORE — server Y.Doc len=${beforeContent.length}, includes BANANA=${beforeContent.includes('BANANA')}`,
  );
  expect(beforeContent).toContain('BANANA');

  return { app, page, port, docName, contentDir, userDataDir };
}

test.describe('PRD-6666 — agent-patch divergence (production-built Electron)', () => {
  // Single-test runs take ~30-60s each (Electron cold launch + race execution
  // + bounded poll). The randomized variant (100 trials locally, 25 under CI)
  // takes up to ~5-8 min locally. CI gets a 150s default budget per
  // `playwright.config.ts:39`; the randomized variant opts into a larger one.

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

    // The four invariants. raceFired === true is THE bug.
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
    // Worst-case: 100 trials × ~6-8s each = ~10-13 min (25 under CI). Plus
    // Electron launch and bounded polls. Give a generous budget.
    test.setTimeout(15 * 60_000);
    const { page, port, docName } = await setupElectron('E', captureStderrFor);

    // 100 trials locally; trimmed under CI to stay within the desktop-smoke
    // job's 30-min budget. This is a regression guard (the bug is fixed), so a
    // smaller CI sample is sufficient.
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
      // Random stagger 0-9 ms.
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
        // Bail out early on first reproduction — we have what we need.
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
