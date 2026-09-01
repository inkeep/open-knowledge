import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { expect, test } from './_helpers/smoke-test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = resolve(__dirname, '..', '..', 'out', 'main', 'index.js');

const SMOKE_ENABLED = process.env.OK_DESKTOP_E2E_SMOKE === '1';
const DARWIN = process.platform === 'darwin';
const BUILD_EXISTS = existsSync(MAIN_ENTRY);

test.describe('Skill scope round-trip', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Deep-link project open is macOS-only in v0.');
  test.skip(!BUILD_EXISTS, `Main build missing at ${MAIN_ENTRY} — run "pnpm run build:desktop".`);

  test('project -> global -> project keeps the sidebar row clickable in one session', async ({
    captureStderrFor,
  }) => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'ok-scope-roundtrip-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-scope-roundtrip-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
    writeFileSync(join(projectDir, 'note.md'), '# Note\n');
    mkdirSync(join(tmpHome, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(projectDir, '.claude', 'skills'), { recursive: true });

    const userDataDir = join(tmpHome, 'electron-userdata');
    mkdirSync(userDataDir, { recursive: true });
    const deepLink = `openknowledge://open?project=${encodeURIComponent(projectDir)}&doc=note`;

    const app = await electron.launch({
      args: [MAIN_ENTRY, deepLink, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, HOME: tmpHome, OK_M6B_FORCE: '1' },
      timeout: 30_000,
    });
    captureStderrFor(app, { cleanupDirs: [projectDir, tmpHome] });
    await app.firstWindow({ timeout: 15_000 });

    const page = await (async () => {
      for (let i = 0; i < 60; i++) {
        for (const w of app.windows()) {
          const hash = await w.evaluate(() => window.location.hash).catch(() => '');
          if (hash.includes('note')) return w;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error('project window never mounted from the argv deep-link');
    })();

    const lockPath = join(projectDir, '.ok', 'local', 'server.lock');
    await expect(() => {
      expect(existsSync(lockPath)).toBe(true);
    }).toPass({ timeout: 15_000 });
    const port = (JSON.parse(readFileSync(lockPath, 'utf-8')) as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    const name = 'roundtrip-smoke';
    const marker = `Roundtrip Smoke ${Date.now()}`;
    const put = await fetch(`${base}/api/skill`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'project',
        name,
        frontmatter: { name, description: 'Round-trip smoke coverage.' },
        body: `# ${marker}\n`,
      }),
    });
    expect(put.status).toBe(200);

    const sidebar = page.locator('[data-slot="sidebar-container"]');
    const trigger = sidebar
      .getByTestId('skills-dock')
      .getByRole('button', { name: 'Skills Studio', exact: true });
    await trigger.waitFor({ timeout: 10_000 });
    const row = page.locator(`[data-item-path="Project/${name}/"]`).first();
    if (!(await row.isVisible().catch(() => false))) await trigger.click();
    await row.waitFor({ timeout: 10_000 });
    await row.click();
    const editor = page.locator('.ProseMirror:not(.composer-prosemirror)').first();
    await expect(editor.filter({ hasText: marker }).first()).toBeVisible({ timeout: 10_000 });

    const move = async (fromScope: string, toScope: string) => {
      const res = await fetch(`${base}/api/skill/move-scope`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, fromScope, toScope }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
    };

    await move('project', 'global');
    await page.locator(`[data-item-path="Global/${name}/"]`).first().waitFor({ timeout: 15_000 });
    await move('global', 'project');
    const backRow = page.locator(`[data-item-path="Project/${name}/"]`).first();
    await backRow.waitFor({ timeout: 15_000 });

    await backRow.click();
    await expect
      .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
        timeout: 10_000,
      })
      .toContain(name);
    await expect(editor.filter({ hasText: marker }).first()).toBeVisible({ timeout: 10_000 });
  });
});
