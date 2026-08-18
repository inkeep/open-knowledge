/**
 * QA smoke: Skills Studio, driven through the real settings pane in a live
 * Electron instance.
 *
 * The change under test moved skill install off the AI tools pages onto a page
 * named after skills and replaced the row subtitle with a human-facing blurb, because the SKILL.md `description` the row used to print
 * is the AGENT's trigger text. Neither fact is observable from a DOM test with
 * a stubbed bridge: the built-in blocks only render when `window.okDesktop`
 * exists, the blurb arrives over IPC from the main process, and the first-visit
 * intro persists its dismissal in the renderer's real localStorage. All three
 * need the real host.
 *
 * HOME is redirected at launch so an install lands in a throwaway home instead
 * of the developer's `~/.claude/skills`. A pre-created `.claude/skills` gives
 * the install a destination to resolve, and a pre-seeded discovery bundle makes
 * `write-skill` the outstanding offer — the state a real user is in after first
 * launch, which is exactly the state setup now leaves them in.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

test.describe('Skills Studio', () => {
  test.skip(!SMOKE_ENABLED, 'Set OK_DESKTOP_E2E_SMOKE=1 to run Electron smoke tests.');
  test.skip(!DARWIN, 'Deep-link project open is macOS-only in v0.');
  test.skip(!BUILD_EXISTS, `Main build missing at ${MAIN_ENTRY} — run "pnpm run build:desktop".`);

  test('installs from the first-visit intro, states what skills are for, and keeps AI tools to connections', async ({
    captureStderrFor,
  }) => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'ok-skills-studio-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-skills-studio-'));
    mkdirSync(join(projectDir, '.ok'), { recursive: true });
    writeFileSync(join(projectDir, '.ok', 'config.yml'), "content:\n  dir: '.'\n");
    writeFileSync(join(projectDir, 'note.md'), '# Note\n');

    // A detected agent host, so an install has somewhere to resolve to.
    mkdirSync(join(tmpHome, '.claude', 'skills'), { recursive: true });
    // Discovery already installed — the post-first-launch state. Leaves
    // write-skill as the one outstanding offer.
    mkdirSync(join(tmpHome, '.claude', 'skills', 'open-knowledge-discovery'), { recursive: true });
    writeFileSync(
      join(tmpHome, '.claude', 'skills', 'open-knowledge-discovery', 'SKILL.md'),
      '---\nname: open-knowledge-discovery\ndescription: "seeded"\n---\n',
    );

    const userDataDir = join(tmpHome, 'electron-userdata');
    mkdirSync(userDataDir, { recursive: true });
    const deepLink = `openknowledge://open?project=${encodeURIComponent(projectDir)}&doc=note`;

    const app = await electron.launch({
      args: [MAIN_ENTRY, deepLink, `--user-data-dir=${userDataDir}`],
      // HOME redirects the skill roots (`os.homedir()`) at the reads AND the
      // writes, so an install lands in the throwaway home rather than the
      // developer's `~/.claude/skills`. OK_M6B_FORCE is the project's own
      // dev-shell escape hatch for the packaged-only gate on `available` —
      // without it every control renders disabled and nothing can be driven.
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

    await page.getByTestId('header-settings-button').click();

    // The sidebar item is named after what it holds.
    const navItem = page.getByTestId('settings-sidebar-item-user-skills');
    await expect(navItem).toBeVisible({ timeout: 10_000 });
    expect((await navItem.textContent())?.trim()).toBe('Skills Studio');
    await navItem.click();

    // First visit explains the page, then offers the skill setup no longer
    // installs.
    const intro = page.getByTestId('skills-studio-intro');
    await expect(intro).toBeVisible({ timeout: 10_000 });
    await expect(intro).toContainText('Skills teach your AI tools repeatable tasks');
    await expect(intro).toContainText('open-knowledge-write-skill');
    await expect(intro).toContainText('How to write a new skill and install it.');
    // Discovery is already installed, so it is not re-offered.
    await expect(intro).not.toContainText('open-knowledge-discovery');

    // Install writes for real. The bundle lands in the redirected home.
    await page.getByTestId('skills-studio-intro-install').click();
    await expect(intro).toBeHidden();
    const installedPath = join(tmpHome, '.claude', 'skills', 'open-knowledge-write-skill');
    await expect(async () => {
      expect(existsSync(join(installedPath, 'SKILL.md'))).toBe(true);
    }).toPass({ timeout: 20_000 });
    // The row reflects it without a reload.
    await expect(page.getByTestId('skills-studio-skill-uninstall-write-skill')).toBeVisible({
      timeout: 15_000,
    });

    // The page says what these skills are, in human words. The
    // frontmatter description is the agent's trigger text and must not be here.
    const section = page.getByTestId('settings-builtin-skills');
    await expect(section).toContainText('Skills from OpenKnowledge');
    await expect(section).toContainText('How to set up new projects with OpenKnowledge.');
    await expect(section).not.toContainText('Do NOT load');
    await expect(section).not.toContainText('Read when the user asks');

    // The folders block leads with the reason, not the mechanism.
    const folders = page.getByTestId('settings-skill-folders');
    await expect(folders).toContainText('Share skills between AI tools');
    await expect(folders).toContainText('Each AI tool reads skills from its own folder');

    // The intro is once-only. Leave settings, come back, no dialog.
    await page.keyboard.press('Escape');
    await page.getByTestId('header-settings-button').click();
    await page.getByTestId('settings-sidebar-item-user-skills').click();
    await expect(page.getByTestId('settings-builtin-skills')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('skills-studio-intro')).toBeHidden();

    // AI tools & CLI keeps the connections and points at the move.
    await page.getByTestId('settings-sidebar-item-ai-tools').click();
    const aiTools = page.getByTestId('ai-tools-skills-moved');
    await expect(aiTools).toBeVisible();
    await expect(aiTools).toContainText('Skills Studio');
    await expect(page.getByTestId('skills-studio-skill-uninstall-write-skill')).toBeHidden();

    // The project scope carries the same provenance heading.
    await page.getByTestId('settings-sidebar-item-skills').click();
    const projectSkill = page.getByTestId('settings-project-skill');
    await expect(projectSkill).toBeVisible({ timeout: 10_000 });
    await expect(projectSkill).toContainText('Skills from OpenKnowledge');
    await expect(projectSkill).toContainText('everyone who opens the project');

    // Under the subtree-gitignored `tmp/`, so a smoke run never leaves an
    // untracked file behind. Nothing asserts on the image; it is a human
    // artifact for reading the final state.
    const shotDir = resolve(__dirname, '..', '..', 'tmp');
    mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: join(shotDir, 'qa-skills-studio.png') });
  });
});
