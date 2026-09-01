import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { createPngBuffer, expect, test } from './_helpers';

function sidebarTreeItem(page: Page, name: string) {
  return page
    .locator('[data-slot="sidebar-container"]')
    .getByRole('treeitem', { name, exact: true });
}

async function expectHash(page: Page, expected: string): Promise<void> {
  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 15_000,
    })
    .toBe(expected);
}

async function expectDocument(page: Page, hash: string, marker: string): Promise<void> {
  await expectHash(page, hash);
  await expect(
    page.locator('.ProseMirror:not(.composer-prosemirror)', { hasText: marker }),
  ).toBeVisible({ timeout: 15_000 });
}

async function expectFolder(page: Page, hash: string, folderName: string): Promise<void> {
  await expectHash(page, hash);
  await expect(
    page
      .locator('[data-active-tab="true"]')
      .getByRole('button', { name: `${folderName}/`, exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Share folder', exact: true })).toBeVisible();
}

async function expectAsset(page: Page, hash: string, assetName: string): Promise<void> {
  await expectHash(page, hash);
  await expect(page.getByRole('main', { name: assetName, exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

async function expectSkillFile(
  page: Page,
  hash: string,
  fileName: string,
  marker: string,
): Promise<void> {
  await expectHash(page, hash);
  const viewer = page.locator('[data-text-viewer][data-text-viewer-state="loaded"]');
  await expect(viewer).toHaveAttribute('aria-label', fileName, { timeout: 15_000 });
  await expect(viewer).toContainText(marker);
}

test('browser history traverses every user-facing navigation target and truncates forward branches', async ({
  page,
  api,
  workerServer,
}) => {
  const id = randomUUID();
  const baselineDoc = `nav-baseline-${id}`;
  const secondDoc = `nav-second-${id}`;
  const folder = `nav-folder-${id}`;
  const assetName = `nav-asset-${id}.png`;
  const assetPath = `${folder}/${assetName}`;
  const indexDoc = `${folder}/index`;
  const indexMarkdown = `# Navigation Index ${id}\n\n![Navigation asset](./${assetName})\n`;
  const indexBumpDoc = `nav-index-bump-${id}`;
  const skillName = `nav-skill-${id}`;
  const bundleFile = `history-${id}.ts`;
  const bundlePath = `scripts/${bundleFile}`;
  const bundleMarker = `navigation-history-${id}`;

  await api.seedDocs([
    { name: baselineDoc, markdown: `# Navigation Baseline ${id}\n` },
    { name: secondDoc, markdown: `# Navigation Second ${id}\n` },
    { name: indexDoc, markdown: indexMarkdown },
  ]);

  writeFileSync(join(workerServer.contentDir, assetPath), createPngBuffer(assetPath));
  writeFileSync(join(workerServer.contentDir, `${indexDoc}.md`), indexMarkdown, 'utf-8');

  try {
    await api.createPage(`${indexBumpDoc}.md`);
    await expect
      .poll(
        async () => {
          const response = await fetch(`${workerServer.baseURL}/api/documents`);
          if (!response.ok) {
            throw new Error(`GET /api/documents failed: ${response.status}`);
          }
          const body = (await response.json()) as {
            documents?: Array<{ kind?: string; path?: string }>;
          };
          return body.documents?.some(
            (entry) => entry.kind === 'asset' && entry.path === assetPath,
          );
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    const skillResponse = await fetch(`${workerServer.baseURL}/api/skill`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'project',
        name: skillName,
        frontmatter: {
          name: skillName,
          description: 'Navigation history browser coverage',
        },
        body: `# Navigation Skill ${id}\n`,
      }),
    });
    expect(skillResponse.status).toBe(200);
    const skillJson = (await skillResponse.json()) as { created: boolean; path: string };
    expect(skillJson).toMatchObject({ created: true, path: expect.stringContaining(skillName) });
    const skillDocHash = `#/${skillJson.path.replace(/\.mdx?$/, '')}`;

    const skillFileResponse = await fetch(`${workerServer.baseURL}/api/skill-file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: 'project',
        name: skillName,
        path: bundlePath,
        content: `export const marker = '${bundleMarker}';\n`,
      }),
    });
    expect(skillFileResponse.status).toBe(200);
    expect(await skillFileResponse.json()).toMatchObject({
      created: true,
      kind: 'script',
      content: false,
      path: expect.stringContaining(bundlePath),
    });

    const baselineHash = `#/${baselineDoc}`;
    const secondHash = `#/${secondDoc}`;
    const folderHash = `#/${folder}/`;
    const indexHash = `#/${indexDoc}`;
    const assetHash = `#/__asset__/${assetPath}`;
    const skillFileHash = `#/__skill-file__/project/${skillName}/${bundlePath}`;

    await page.goto(`/${baselineHash}`);
    await expectDocument(page, baselineHash, `Navigation Baseline ${id}`);

    await sidebarTreeItem(page, `${secondDoc}.md`).click();
    await expectDocument(page, secondHash, `Navigation Second ${id}`);

    await sidebarTreeItem(page, folder).click();
    await expectFolder(page, folderHash, folder);

    await sidebarTreeItem(page, 'index.md').click();
    await expectDocument(page, indexHash, `Navigation Index ${id}`);

    await sidebarTreeItem(page, assetName).click();
    await expectAsset(page, assetHash, assetName);

    const sidebar = page.locator('[data-slot="sidebar-container"]');
    await sidebar
      .getByTestId('skills-dock')
      .getByRole('button', { name: 'Skills Studio', exact: true })
      .click();
    const projectGroup = sidebar.getByText('Project', { exact: true }).first();
    await projectGroup.waitFor({ timeout: 15_000 });
    const skillRow = sidebar.getByText(skillName, { exact: true }).first();
    if (!(await skillRow.isVisible())) {
      await projectGroup.click();
    }
    await skillRow.click();
    await sidebar.getByText('scripts', { exact: true }).first().click();
    await sidebar.getByText(bundleFile.replace(/\.ts$/, ''), { exact: true }).first().click();
    await expectSkillFile(page, skillFileHash, bundleFile, bundleMarker);

    await page.goBack();
    await expectDocument(page, skillDocHash, `Navigation Skill ${id}`);
    await page.goBack();
    await expectAsset(page, assetHash, assetName);
    await page.goBack();
    await expectDocument(page, indexHash, `Navigation Index ${id}`);
    await page.goBack();
    await expectFolder(page, folderHash, folder);
    await page.goBack();
    await expectDocument(page, secondHash, `Navigation Second ${id}`);
    await page.goBack();
    await expectDocument(page, baselineHash, `Navigation Baseline ${id}`);

    await page.goForward();
    await expectDocument(page, secondHash, `Navigation Second ${id}`);
    await page.goForward();
    await expectFolder(page, folderHash, folder);
    await page.goForward();
    await expectDocument(page, indexHash, `Navigation Index ${id}`);
    await page.goForward();
    await expectAsset(page, assetHash, assetName);
    await page.goForward();
    await expectDocument(page, skillDocHash, `Navigation Skill ${id}`);
    await page.goForward();
    await expectSkillFile(page, skillFileHash, bundleFile, bundleMarker);

    await page.goBack();
    await expectDocument(page, skillDocHash, `Navigation Skill ${id}`);
    await page.goBack();
    await expectAsset(page, assetHash, assetName);
    await sidebarTreeItem(page, `${baselineDoc}.md`).click();
    await expectDocument(page, baselineHash, `Navigation Baseline ${id}`);
    await page.goForward();
    await expectDocument(page, baselineHash, `Navigation Baseline ${id}`);
  } finally {
    rmSync(join(workerServer.contentDir, assetPath), { force: true });
  }
});
