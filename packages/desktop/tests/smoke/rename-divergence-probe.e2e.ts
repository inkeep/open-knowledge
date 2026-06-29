
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const MARKER_PREFIX = 'rename-divergence-PROBE';
const YDOC_REHYDRATE_BUDGET_MS = 15_000;
const YDOC_POLL_INTERVAL_MS = 250;

interface ProbeOutcome {
  variant: 'with-ext' | 'no-ext';
  typedName: string;
  expectedDocName: string;
  diskExists: boolean;
  diskBytes: number;
  diskHasMarker: boolean;
  yDocLen: number;
  yDocHasMarker: boolean;
  oldFileExists: boolean;
  raceFired: boolean;
}

async function runProbe(
  variant: 'with-ext' | 'no-ext',
  captureStderrFor: (app: ElectronApplication) => void,
): Promise<ProbeOutcome> {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Driver uses macOS open(1).');
  test.skip(!existsSync(MAIN_ENTRY), `out/main/index.js missing — run \`bun run build:desktop\`.`);

  const contentDir = mkdtempSync(join(tmpdir(), `ok-rename-probe-${variant}-`));
  const userDataDir = mkdtempSync(join(tmpdir(), `ok-pw-userdata-${variant}-`));
  const sourceDocName = `probe-${variant}-${randomUUID().slice(0, 8)}`;
  const marker = `${MARKER_PREFIX}-${variant}-${randomUUID().slice(0, 8)}`;
  const sourceContent = `# Probe doc\n\nMarker: ${marker}.\n\nParagraph two — non-trivial content for rename.\n\nParagraph three.\n`;

  mkdirSync(join(contentDir, '.ok'), { recursive: true });
  writeFileSync(join(contentDir, '.ok', 'config.yml'), 'content:\n  dir: .\n');
  writeFileSync(join(contentDir, `${sourceDocName}.md`), sourceContent);

  const deepLink = `openknowledge://open?project=${encodeURIComponent(
    contentDir,
  )}&doc=${encodeURIComponent(sourceDocName)}`;

  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, deepLink],
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 30_000,
  });
  captureStderrFor(app);

  try {
    const expectedHashSuffix = `#/${sourceDocName}`;
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
    ).toContainText(marker, { timeout: 30_000 });

    const apiOrigin = await page.evaluate(() => window.okDesktop?.config?.apiOrigin);
    if (!apiOrigin) {
      throw new Error(`window.okDesktop.config.apiOrigin was empty (got: ${apiOrigin})`);
    }
    const port = Number(new URL(apiOrigin).port);
    console.log(`[PROBE ${variant}] API port: ${port}`);

    const r = await fetch(`http://localhost:${port}/api/document?docName=${sourceDocName}`);
    const j = (await r.json()) as { content?: string };
    const len = j.content?.length ?? 0;
    console.log(`[PROBE ${variant}] BEFORE rename — server Y.Doc len=${len}`);
    expect(len).toBeGreaterThan(0);

    const typedName = variant === 'with-ext' ? 'renamed-target.md' : 'renamed-target';
    const expectedDocName = 'renamed-target';
    const sourceItem = page.getByRole('treeitem', { name: new RegExp(`${sourceDocName}\\.md`) });
    await sourceItem.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /rename/i }).click({ timeout: 5_000 });
    const renameInput = page.getByRole('textbox', {
      name: new RegExp(`rename ${sourceDocName}\\.md`, 'i'),
    });
    await renameInput.fill(typedName);
    await renameInput.press('Enter');

    let yDocLen = -1;
    let yDocHasMarker = false;
    const deadline = Date.now() + YDOC_REHYDRATE_BUDGET_MS;
    while (Date.now() < deadline) {
      const r = await fetch(
        `http://localhost:${port}/api/document?docName=${expectedDocName}`,
      ).catch(() => null);
      if (r) {
        const j = (await r.json().catch(() => ({}))) as { content?: string };
        yDocLen = j.content?.length ?? 0;
        yDocHasMarker = (j.content ?? '').includes(marker);
        if (yDocHasMarker) break;
      }
      await wait(YDOC_POLL_INTERVAL_MS);
    }

    const newDiskPath = join(contentDir, `${expectedDocName}.md`);
    const oldDiskPath = join(contentDir, `${sourceDocName}.md`);
    const diskExists = existsSync(newDiskPath);
    const diskContent = diskExists ? readFileSync(newDiskPath, 'utf-8') : '';
    const diskBytes = diskContent.length;
    const diskHasMarker = diskContent.includes(marker);
    const oldFileExists = existsSync(oldDiskPath);

    const raceFired = diskHasMarker && !yDocHasMarker;

    const outcome: ProbeOutcome = {
      variant,
      typedName,
      expectedDocName,
      diskExists,
      diskBytes,
      diskHasMarker,
      yDocLen,
      yDocHasMarker,
      oldFileExists,
      raceFired,
    };
    console.log(`[PROBE ${variant}] OUTCOME:`, outcome);

    return outcome;
  } finally {
    for (const dir of [contentDir, userDataDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
      }
    }
  }
}

test.describe('Production-built Electron — rename divergence probe', () => {
  test('with .md extension typed', async ({ captureStderrFor }) => {
    const outcome = await runProbe('with-ext', captureStderrFor);
    expect(outcome.diskHasMarker).toBe(true);
    expect(outcome.oldFileExists).toBe(false);
    expect(outcome.yDocHasMarker).toBe(true);
    expect(outcome.raceFired).toBe(false);
  });

  test('without .md extension typed (user gesture)', async ({ captureStderrFor }) => {
    const outcome = await runProbe('no-ext', captureStderrFor);
    expect(outcome.diskHasMarker).toBe(true);
    expect(outcome.oldFileExists).toBe(false);
    expect(outcome.yDocHasMarker).toBe(true);
    expect(outcome.raceFired).toBe(false);
  });
});
