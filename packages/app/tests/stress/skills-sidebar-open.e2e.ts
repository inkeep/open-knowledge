import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

function skillRow(page: Page, path: string) {
  return page.locator(`[data-item-path="${path}"]`).first();
}

async function expandSkillsDock(page: Page): Promise<void> {
  const sidebar = page.locator('[data-slot="sidebar-container"]');
  const trigger = sidebar
    .getByTestId('skills-dock')
    .getByRole('button', { name: 'Skills Studio', exact: true });
  await trigger.waitFor({ timeout: 15_000 });
  const projectGroup = skillRow(page, 'Project/');
  if (!(await projectGroup.isVisible().catch(() => false))) {
    await trigger.click();
  }
  await projectGroup.waitFor({ timeout: 15_000 });
}

async function createSkill(baseURL: string, name: string, body: string): Promise<{ path: string }> {
  const res = await fetch(`${baseURL}/api/skill`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope: 'project',
      name,
      frontmatter: { name, description: `Sidebar-open coverage for ${name}.` },
      body,
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { path: string };
}

function activeEditor(page: Page) {
  return page.locator('.ProseMirror:not(.composer-prosemirror)');
}

test('a freshly created skill opens on the first row click amid list churn', async ({
  page,
  api,
  workerServer,
}) => {
  await api.testReset();
  await page.goto('/');
  await expandSkillsDock(page);

  const name = 'churn-open-skill';
  const marker = `Churn Open ${Date.now()}`;
  await createSkill(workerServer.baseURL, 'churn-sibling', '# Sibling\n');
  await createSkill(workerServer.baseURL, name, `# ${marker}\n`);

  const row = skillRow(page, `Project/${name}/`);
  await row.waitFor({ timeout: 15_000 });
  await row.click();

  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 15_000,
    })
    .toContain(name);
  await expect(activeEditor(page).filter({ hasText: marker })).toBeVisible({ timeout: 15_000 });
});

test('a closed skill tab stays closed until the row is clicked again', async ({
  page,
  api,
  workerServer,
}) => {
  await api.testReset();
  const name = 'close-sticks-skill';
  const otherName = 'close-sticks-other';
  const marker = `Close Sticks ${Date.now()}`;
  const otherMarker = `Close Sticks Other ${Date.now()}`;
  await createSkill(workerServer.baseURL, name, `# ${marker}\n`);
  await createSkill(workerServer.baseURL, otherName, `# ${otherMarker}\n`);

  await page.goto('/');
  await expandSkillsDock(page);
  const row = skillRow(page, `Project/${name}/`);
  await row.waitFor({ timeout: 15_000 });
  await row.click();
  await expect(activeEditor(page).filter({ hasText: marker })).toBeVisible({ timeout: 15_000 });

  const tab = page.getByRole('main').locator('[data-active-tab="true"]');
  await tab.hover();
  await tab.getByTestId('editor-tab-close-button').click();
  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 15_000,
    })
    .not.toContain(name);

  const otherRow = skillRow(page, `Project/${otherName}/`);
  await otherRow.click();
  await expect(activeEditor(page).filter({ hasText: otherMarker })).toBeVisible({
    timeout: 15_000,
  });
  expect(decodeURIComponent(await page.evaluate(() => window.location.hash))).not.toContain(name);
  await expect(page.getByRole('main').getByRole('button', { name: `${name}.md` })).toHaveCount(0);

  await row.click();
  await expect(activeEditor(page).filter({ hasText: marker })).toBeVisible({ timeout: 15_000 });
});

test('back from a bundle-file tab lands on the skill doc without crashing', async ({
  page,
  api,
  workerServer,
}) => {
  await api.testReset();
  const name = 'back-nav-skill';
  const marker = `Back Nav ${Date.now()}`;
  await createSkill(workerServer.baseURL, name, `# ${marker}\n`);
  const fileRes = await fetch(`${workerServer.baseURL}/api/skill-file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope: 'project',
      name,
      path: 'scripts/back-nav.ts',
      content: 'export const marker = 1;\n',
    }),
  });
  expect(fileRes.status).toBe(200);

  await page.goto('/');
  await expandSkillsDock(page);
  const row = skillRow(page, `Project/${name}/`);
  await row.waitFor({ timeout: 15_000 });
  await row.click();
  await expect(activeEditor(page).filter({ hasText: marker })).toBeVisible({ timeout: 15_000 });

  await skillRow(page, `Project/${name}/scripts/`).click();
  const fileRow = skillRow(page, `Project/${name}/scripts/back-nav.ts`);
  await fileRow.waitFor({ timeout: 15_000 });
  await fileRow.click();
  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 15_000,
    })
    .toContain('back-nav.ts');

  await page.goBack();
  await expect(activeEditor(page).filter({ hasText: marker })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});

test('explore install: the destination menu survives the first pick and hands off on close', async ({
  page,
  api,
  workerServer,
}) => {
  await api.testReset();
  const name = 'explore-local-skill';
  const marker = `Explore Local ${Date.now()}`;
  const sourceDir = join(workerServer.contentDir, '..', `explore-source-${Date.now()}`);
  mkdirSync(join(sourceDir, name), { recursive: true });
  writeFileSync(
    join(sourceDir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Explore install coverage.\n---\n\n# ${marker}\n`,
  );
  mkdirSync(join(workerServer.contentDir, '.claude', 'skills'), { recursive: true });

  await page.route(/\/api\/skills(\?|$)/, async (route) => {
    if (route.request().method() === 'GET') {
      console.log('[list-delay] holding', route.request().url());
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      console.log('[list-delay] released', route.request().url());
    }
    await route.continue();
  });
  await page.route('**/api/skills/search**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [
          {
            id: `${name}-local`,
            name,
            source: sourceDir,
            installs: 1,
            description: 'Explore install coverage.',
          },
        ],
        backend: 'skills.sh',
        degraded: false,
      }),
    });
  });

  await page.goto('/');
  await expandSkillsDock(page);
  await skillRow(page, 'Project/').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Explore skills' }).click();
  await page
    .getByPlaceholder(/search/i)
    .first()
    .fill(name);
  const viewButton = page.getByRole('button', { name: `View ${name}` }).first();
  await viewButton.waitFor({ timeout: 15_000 });
  await viewButton.click();

  const installButton = page.getByRole('button', { name: /^Install( this skill)?$/ }).first();
  await installButton.waitFor({ timeout: 20_000 });
  await installButton.click();
  const claudeItem = page.getByRole('menuitemcheckbox', { name: /claude/i }).first();
  await claudeItem.waitFor({ timeout: 15_000 });
  await claudeItem.click();

  await expect
    .poll(async () => page.evaluate(() => document.querySelectorAll('[role="menu"]').length), {
      timeout: 30_000,
    })
    .toBe(1);
  const skillLanded = join(workerServer.contentDir, '.agents', 'skills', name, 'SKILL.md');
  await expect
    .poll(
      async () => {
        const res = await fetch(`${workerServer.baseURL}/api/skills?scope=project`);
        const body = (await res.json()) as { skills?: Array<{ name: string }> };
        return body.skills?.some((s) => s.name === name) ?? false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  void skillLanded;

  await page.keyboard.press('Escape');
  await page.mouse.click(10, 400);
  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 4_000,
    })
    .toMatch(new RegExp(`skills/${name}/SKILL$`));
  await expect(activeEditor(page).filter({ hasText: marker })).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      async () => {
        const res = await fetch(`${workerServer.baseURL}/api/skills?scope=project`);
        const body = (await res.json()) as { skills?: Array<{ name: string }> };
        return body.skills?.some((s) => s.name === name) ?? false;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
});

test('shift-click ranges and cmd-click toggles drag the whole selection to the other scope', async ({
  page,
  api,
  workerServer,
}) => {
  await api.testReset();
  const names = ['multi-a', 'multi-b', 'multi-c'];
  for (const n of names) {
    await createSkill(workerServer.baseURL, n, `# Multi ${n}\n`);
  }

  await page.goto('/');
  await expandSkillsDock(page);
  const first = skillRow(page, `Project/${names[0]}/`);
  await first.waitFor({ timeout: 15_000 });

  await first.click();
  await skillRow(page, `Project/${names[2]}/`).click({ modifiers: ['Shift'] });
  await expect
    .poll(async () =>
      page.evaluate(() => {
        let count = 0;
        const walk = (root: Document | ShadowRoot) => {
          for (const _e of root.querySelectorAll('[data-item-path][data-item-selected="true"]'))
            count += 1;
          for (const e of root.querySelectorAll('*')) if (e.shadowRoot) walk(e.shadowRoot);
        };
        walk(document);
        return count;
      }),
    )
    .toBeGreaterThanOrEqual(3);

  const selectedCount = () =>
    page.evaluate(() => {
      let count = 0;
      const walk = (root: Document | ShadowRoot) => {
        for (const _e of root.querySelectorAll('[data-item-path][data-item-selected="true"]'))
          count += 1;
        for (const e of root.querySelectorAll('*')) if (e.shadowRoot) walk(e.shadowRoot);
      };
      walk(document);
      return count;
    });
  const fullRange = await selectedCount();
  await page.keyboard.press('Shift+ArrowUp');
  await expect.poll(selectedCount).toBeLessThan(fullRange);
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(selectedCount).toBe(fullRange);

  await skillRow(page, `Project/${names[1]}/`).click({ modifiers: ['ControlOrMeta'] });

  const moveRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/skill/move-scope') && req.method() === 'POST') {
      const body = req.postDataJSON() as { name?: string; toScope?: string } | null;
      if (body?.name) moveRequests.push(`${body.name}:${body.toScope}`);
    }
  });

  await page.evaluate(
    ({ src, dst }) => {
      const find = (p: string) => {
        let el: Element | null = null;
        const walk = (root: Document | ShadowRoot) => {
          for (const e of root.querySelectorAll(`[data-item-path="${p}"]`)) el = e;
          for (const e of root.querySelectorAll('*')) if (e.shadowRoot) walk(e.shadowRoot);
        };
        walk(document);
        return el;
      };
      const source = find(src);
      const target = find(dst);
      if (!source || !target) throw new Error('drag rows missing');
      const dt = new DataTransfer();
      const fire = (el: Element, type: string) =>
        el.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            composed: true,
            cancelable: true,
            dataTransfer: dt,
          }),
        );
      fire(source, 'dragstart');
      fire(target, 'dragover');
      fire(target, 'drop');
      fire(source, 'dragend');
    },
    { src: `Project/${names[0]}/`, dst: 'Global/' },
  );

  await expect
    .poll(() => moveRequests.slice().sort().join(','), { timeout: 30_000 })
    .toBe(`${names[0]}:global,${names[2]}:global`);
});

test('shift+arrow walks visible rows through read-only plugin skills; drag moves only movable members', async ({
  page,
  api,
  workerServer,
}) => {
  await api.testReset();
  for (const n of ['aa-nav-a', 'aa-nav-b']) {
    await createSkill(workerServer.baseURL, n, `# Nav ${n}\n`);
  }

  const projectDir = realpathSync(workerServer.contentDir);
  const pluginsDir = join(workerServer.contentDir, '.claude', 'plugins');
  const cacheDir = join(pluginsDir, 'cache', 'zz-plug');
  for (const skill of ['plug-one', 'plug-two']) {
    const dir = join(cacheDir, 'skills', skill);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${skill}\ndescription: fixture plugin skill\n---\n# ${skill}\n`,
      'utf-8',
    );
  }
  writeFileSync(
    join(pluginsDir, 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'zz-plug@mkt': [
          {
            scope: 'project',
            projectPath: projectDir,
            installPath: cacheDir,
            version: '1.0.0',
            lastUpdated: '2026-01-01T00:00:00Z',
          },
        ],
      },
    }),
    'utf-8',
  );

  await page.goto('/');
  await expandSkillsDock(page);
  await skillRow(page, 'Project/aa-nav-a/').waitFor({ timeout: 15_000 });
  const groupRow = skillRow(page, 'Project/zz-plug/');
  await groupRow.waitFor({ timeout: 15_000 });

  const selectedPaths = () =>
    page.evaluate(() => {
      const out: string[] = [];
      const walk = (root: Document | ShadowRoot) => {
        for (const e of root.querySelectorAll('[data-item-path][data-item-selected="true"]'))
          out.push(e.getAttribute('data-item-path') ?? '');
        for (const e of root.querySelectorAll('*')) if (e.shadowRoot) walk(e.shadowRoot);
      };
      walk(document);
      return out.sort().join(',');
    });

  await groupRow.click();
  await skillRow(page, 'Project/zz-plug/plug-one/').waitFor({ timeout: 15_000 });
  await skillRow(page, 'Project/aa-nav-a/').click();
  await skillRow(page, 'Project/aa-nav-b/').click({ modifiers: ['Shift'] });
  await expect.poll(selectedPaths).toContain('Project/aa-nav-b/');

  const visibleOrder = await page.evaluate(() => {
    const out: string[] = [];
    const walk = (root: Document | ShadowRoot) => {
      for (const e of root.querySelectorAll('[data-item-path]'))
        out.push(e.getAttribute('data-item-path') ?? '');
      for (const e of root.querySelectorAll('*')) if (e.shadowRoot) walk(e.shadowRoot);
    };
    walk(document);
    return out;
  });
  const presses =
    visibleOrder.indexOf('Project/zz-plug/plug-two/') - visibleOrder.indexOf('Project/aa-nav-b/');
  expect(presses).toBeGreaterThan(0);
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press('Shift+ArrowDown');
  }
  await expect.poll(selectedPaths).toContain('Project/zz-plug/plug-one/');
  await expect.poll(selectedPaths).toContain('Project/zz-plug/plug-two/');
  await page.keyboard.press('Shift+ArrowUp');
  await expect.poll(selectedPaths).not.toContain('Project/zz-plug/plug-two/');

  const moveRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/skill/move-scope') && req.method() === 'POST') {
      const body = req.postDataJSON() as { name?: string } | null;
      if (body?.name) moveRequests.push(body.name);
    }
  });
  await page.evaluate(() => {
    const find = (root: Document | ShadowRoot, path: string): HTMLElement | null => {
      const hit = root.querySelector(`[data-item-path="${path}"]`);
      if (hit) return hit as HTMLElement;
      for (const e of root.querySelectorAll('*')) {
        if (e.shadowRoot) {
          const nested = find(e.shadowRoot, path);
          if (nested) return nested;
        }
      }
      return null;
    };
    const from = find(document, 'Project/aa-nav-a/');
    const to = find(document, 'Global/');
    if (!from || !to) throw new Error('drag rows missing');
    const dt = new DataTransfer();
    for (const [type, target] of [
      ['dragstart', from],
      ['dragover', to],
      ['drop', to],
      ['dragend', from],
    ] as const) {
      target.dispatchEvent(
        new DragEvent(type, { bubbles: true, composed: true, cancelable: true, dataTransfer: dt }),
      );
    }
  });
  await expect
    .poll(() => moveRequests.slice().sort().join(','), { timeout: 30_000 })
    .toContain('aa-nav-a,aa-nav-b');
  expect(moveRequests).not.toContain('plug-one');
  expect(moveRequests).not.toContain('plug-two');
  expect(moveRequests).not.toContain('open-knowledge');
});

test('renaming a skill from the Properties name field follows the rename everywhere', async ({
  page,
  api,
  workerServer,
}) => {
  await api.testReset();
  await createSkill(workerServer.baseURL, 'rename-me', '# Rename target\n');

  await page.goto('/');
  await expandSkillsDock(page);
  const row = skillRow(page, 'Project/rename-me/');
  await row.waitFor({ timeout: 15_000 });
  await row.click();
  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 15_000,
    })
    .toContain('rename-me');

  const nameInput = page.getByTestId('skill-name-input');
  await nameInput.waitFor({ timeout: 15_000 });
  await nameInput.fill('renamed-target');
  await nameInput.press('Enter');

  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 20_000,
    })
    .toContain('renamed-target');
  await skillRow(page, 'Project/renamed-target/').waitFor({ timeout: 15_000 });
  await expect(skillRow(page, 'Project/rename-me/')).toHaveCount(0);
  await expect(page.getByTestId('skill-name-input').last()).toHaveValue('renamed-target');
});

test('skill lifecycle in the .agents home: create, edit, menu rename, menu move', async ({
  page,
  api,
  workerServer,
}) => {
  await api.testReset();
  const agentsHome = join(workerServer.contentDir, '.agents');
  mkdirSync(join(agentsHome, 'skills'), { recursive: true });
  try {
    await runLifecycleJourney(page, workerServer);
  } finally {
    rmSync(agentsHome, { recursive: true, force: true });
  }
});

async function runLifecycleJourney(
  page: Page,
  workerServer: { baseURL: string; contentDir: string },
): Promise<void> {
  const created = await createSkill(workerServer.baseURL, 'lifecycle-skill', '# Lifecycle\n');
  expect(created.path.startsWith('.agents/skills/')).toBe(true);

  await page.goto('/');
  await expandSkillsDock(page);
  const row = skillRow(page, 'Project/lifecycle-skill/');
  await row.waitFor({ timeout: 15_000 });
  await row.click();
  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 15_000,
    })
    .toContain('lifecycle-skill');

  const editor = page.locator('.ProseMirror:visible').first();
  await editor.waitFor({ timeout: 15_000 });
  await editor.getByText('Lifecycle').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('Edited body line');
  await expect(editor).toContainText('Edited body line');
  const skillMdPath = join(
    workerServer.contentDir,
    '.agents',
    'skills',
    'lifecycle-skill',
    'SKILL.md',
  );
  await expect
    .poll(
      () => {
        try {
          return readFileSync(skillMdPath, 'utf-8');
        } catch {
          return '';
        }
      },
      { timeout: 40_000 },
    )
    .toContain('Edited body line');

  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('lifecycle-renamed');
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await skillRow(page, 'Project/lifecycle-renamed/').waitFor({ timeout: 15_000 });
  await expect(skillRow(page, 'Project/lifecycle-skill/')).toHaveCount(0);
  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 20_000,
    })
    .toContain('lifecycle-renamed');

  const moveRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/skill/move-scope') && req.method() === 'POST') {
      const body = req.postDataJSON() as { name?: string; toScope?: string } | null;
      if (body?.name) moveRequests.push(`${body.name}:${body.toScope}`);
    }
  });
  await skillRow(page, 'Project/lifecycle-renamed/').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Move to/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Move', exact: true }).click();
  await expect
    .poll(() => moveRequests.join(','), { timeout: 20_000 })
    .toContain('lifecycle-renamed:global');
}

test('New skill from the scope menu auto-opens and STAYS open under a slow skills list', async ({
  page,
  api,
}) => {
  await api.testReset();

  let delayedResponses = 0;
  await page.route(/\/api\/skills(\?|$)/, async (route) => {
    if (route.request().method() === 'GET') {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      delayedResponses += 1;
    }
    await route.continue();
  });

  await page.goto('/');
  await expandSkillsDock(page);
  const scopeRow = skillRow(page, 'Project/');
  await scopeRow.waitFor({ timeout: 15_000 });
  await scopeRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New skill' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').first().fill('auto-open-new');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();

  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 20_000,
    })
    .toContain('auto-open-new');

  const seen = delayedResponses;
  await expect.poll(() => delayedResponses, { timeout: 20_000 }).toBeGreaterThan(seen + 1);
  expect(decodeURIComponent(await page.evaluate(() => window.location.hash))).toContain(
    'auto-open-new',
  );
});

test('an imported skill row opens on the FIRST click, under a slow skills list', async ({
  page,
  api,
  workerServer,
}) => {
  await api.testReset();
  const name = 'imported-first-click';
  const sourceDir = join(workerServer.contentDir, '..', `import-source-${Date.now()}`);
  mkdirSync(join(sourceDir, name), { recursive: true });
  writeFileSync(
    join(sourceDir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Imported first-click coverage.\n---\n\n# Imported ${name}\n`,
  );
  mkdirSync(join(workerServer.contentDir, '.claude', 'skills'), { recursive: true });

  await page.route(/\/api\/skills(\?|$)/, async (route) => {
    if (route.request().method() === 'GET') {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    await route.continue();
  });

  await page.goto('/');
  await expandSkillsDock(page);
  await skillRow(page, 'Project/').waitFor({ timeout: 20_000 });

  const imp = await fetch(`${workerServer.baseURL}/api/skill/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: sourceDir, skill: name, scope: 'project', install: false }),
  });
  expect(imp.ok).toBe(true);

  const row = skillRow(page, `Project/${name}/`);
  await row.waitFor({ timeout: 30_000 });
  await row.click();
  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 20_000,
    })
    .toMatch(new RegExp(`skills/${name}/SKILL$`));
});

test('Delete key removes a multi-selection even when one of the docs is open', async ({
  page,
  api,
  workerServer,
}) => {
  await api.testReset();
  for (const n of ['bulk-del-a', 'bulk-del-b', 'bulk-del-c']) {
    await createSkill(workerServer.baseURL, n, `# Del ${n}\n`);
  }

  await page.goto('/');
  await expandSkillsDock(page);
  const rowA = skillRow(page, 'Project/bulk-del-a/');
  await rowA.waitFor({ timeout: 15_000 });
  await rowA.click();
  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 15_000,
    })
    .toContain('bulk-del-a');

  await rowA.click({ modifiers: ['ControlOrMeta'] });
  await skillRow(page, 'Project/bulk-del-b/').click({ modifiers: ['ControlOrMeta'] });
  await skillRow(page, 'Project/bulk-del-c/').click({ modifiers: ['ControlOrMeta'] });

  await page.keyboard.press('Delete');
  const dialog = page.getByRole('alertdialog');
  await dialog.waitFor({ timeout: 10_000 });
  await dialog.getByRole('button', { name: /delete/i }).click();

  for (const n of ['bulk-del-a', 'bulk-del-b', 'bulk-del-c']) {
    await expect(skillRow(page, `Project/${n}/`)).toHaveCount(0, { timeout: 30_000 });
  }
  await expect
    .poll(
      async () => {
        const res = await fetch(`${workerServer.baseURL}/api/skills?scope=project`);
        const body = (await res.json()) as { skills?: Array<{ name: string }> };
        return (body.skills ?? []).filter((s) => s.name.startsWith('bulk-del-')).length;
      },
      { timeout: 30_000 },
    )
    .toBe(0);
});

test('a skills.sh import surfaces its sidebar row without any other churn', async ({
  page,
  api,
  workerServer,
}) => {
  await api.testReset();
  const name = 'import-row-skill';
  const sourceDir = join(workerServer.contentDir, '..', `import-row-source-${Date.now()}`);
  mkdirSync(join(sourceDir, name), { recursive: true });
  writeFileSync(
    join(sourceDir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Import row coverage.\n---\n\n# Import Row\n`,
  );

  await page.goto('/');
  await expandSkillsDock(page);

  const res = await fetch(`${workerServer.baseURL}/api/skill/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: sourceDir, skill: name, scope: 'project', install: false }),
  });
  expect(res.status).toBe(200);

  const row = skillRow(page, `Project/${name}/`);
  await row.waitFor({ timeout: 15_000 });
  await row.click();
  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 15_000,
    })
    .toContain(name);
  rmSync(sourceDir, { recursive: true, force: true });
});
