/**
 * Browser coverage for the skills-sidebar open lifecycle — the behavior family
 * a week of usability sessions kept tripping over:
 *
 *  - a freshly created/imported skill's row must open on the FIRST click, even
 *    while the sidebar tree is remounting under the install's list churn (the
 *    repeated "cannot open the skill I just installed" reports);
 *  - a closed skill tab must STAY closed — an earlier fix completed swallowed
 *    clicks by guessing from Pierre selection state, which re-opened tabs the
 *    user had just closed;
 *  - navigating back from a bundle-file tab must land on the skill doc without
 *    the two openers fighting (the Maximum-update-depth app crash);
 *  - the explore install flow: the destination menu survives the first pick
 *    (the redirect used to unmount it mid-choice), and closing the menu hands
 *    off to the real skill tab.
 *
 * Skill rows live inside Pierre's shadow DOM; Playwright locators pierce it,
 * so `[data-item-path]` selects rows directly. Paths are `<Scope>/<name>/`.
 */

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
  // The dock's expanded state persists per browser profile; each test gets a
  // fresh context, so the dock starts collapsed and one click opens it.
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
  // Create a sibling right before the target so the list is actively churning
  // (each create → skills-changed → tree remount) when the click lands.
  await createSkill(workerServer.baseURL, 'churn-sibling', '# Sibling\n');
  await createSkill(workerServer.baseURL, name, `# ${marker}\n`);

  const row = skillRow(page, `Project/${name}/`);
  await row.waitFor({ timeout: 15_000 });
  await row.click();

  // The click must land the skill WITHOUT clicking any other row first — the
  // historical failure mode was "dead until I click another skill". The
  // pending-click record completes a click even when a remount interrupts it,
  // so a single click suffices; the poll only absorbs the open's async hop.
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

  // Close the tab through its own close button.
  const tab = page.getByRole('main').locator('[data-active-tab="true"]');
  await tab.hover();
  await tab.getByTestId('editor-tab-close-button').click();
  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 15_000,
    })
    .not.toContain(name);

  // The regression this pins: a phantom "swallowed click" completion re-opened
  // the tab moments after every close. Event-driven probe rather than a sleep:
  // open ANOTHER skill — its render cycle is exactly where the phantom replay
  // used to fire — and the closed skill must not resurface alongside it.
  const otherRow = skillRow(page, `Project/${otherName}/`);
  await otherRow.click();
  await expect(activeEditor(page).filter({ hasText: otherMarker })).toBeVisible({
    timeout: 15_000,
  });
  expect(decodeURIComponent(await page.evaluate(() => window.location.hash))).not.toContain(name);
  await expect(page.getByRole('main').getByRole('button', { name: `${name}.md` })).toHaveCount(0);

  // And the row still works: one click re-opens.
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
  // Two openers used to fight here (the hash effect re-opening the doc against
  // a phantom skill-file re-activation) until React hit Maximum update depth
  // and the app-shell error boundary swallowed the whole window.
  await expect(activeEditor(page).filter({ hasText: marker })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
});

test('explore install: the destination menu survives the first pick and hands off on close', async ({
  page,
  api,
  workerServer,
}) => {
  await api.testReset();
  // A local bundle stands in for a skills.sh listing: the import endpoint
  // accepts absolute-path sources, so the whole preview → import → install
  // pipeline runs for real with no network.
  const name = 'explore-local-skill';
  const marker = `Explore Local ${Date.now()}`;
  const sourceDir = join(workerServer.contentDir, '..', `explore-source-${Date.now()}`);
  mkdirSync(join(sourceDir, name), { recursive: true });
  writeFileSync(
    join(sourceDir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Explore install coverage.\n---\n\n# ${marker}\n`,
  );
  // The project needs an adopted editor root for the install fan-out target.
  mkdirSync(join(workerServer.contentDir, '.claude', 'skills'), { recursive: true });

  // Field conditions: on a monorepo-sized content root /api/skills takes
  // seconds, and the install auto-open used to be GATED on that list - the
  // preview sat un-redirected long enough to read as "install didn't open
  // the skill". Delay every list response so the redirect can only pass the
  // bounded assertion below by NOT waiting on the list.
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
  // Scope-row context menu → Explore skills opens the add-skill dialog.
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

  // The import + install run while the menu stays open — the redirect used to
  // replace the tab underneath it, unmounting the menu mid-choice.
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

  // Closing the menu is the handoff: the preview becomes the real skill tab.
  // Bounded WELL below the list delay: the redirect must ride the install
  // response's own path report, not a skills-list refetch.
  await page.keyboard.press('Escape');
  // Belt over the Escape: a click outside is the other real close gesture,
  // and pressing Escape in the same tick the menu finishes mounting can be
  // swallowed by its focus setup.
  await page.mouse.click(10, 400);
  // The PREVIEW's own hash also contains the skill name, so the assertion
  // demands the real live-doc shape - anything still preview-shaped fails.
  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 4_000,
    })
    .toMatch(new RegExp(`skills/${name}/SKILL$`));
  await expect(activeEditor(page).filter({ hasText: marker })).toBeVisible({ timeout: 15_000 });
  // Landing check runs LAST so it cannot pad the redirect timing above.
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

  // Plain click sets the range anchor; shift-click sweeps the contiguous rows.
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

  // Shift+ArrowDown extends the range by one more row from the keyboard.
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
  // The range ends at the harness's last row, so walk the cursor UP first
  // (shrinks the range) and back DOWN (restores it) — direction-agnostic proof
  // the keyboard drives the same range the shift-click built.
  const fullRange = await selectedCount();
  await page.keyboard.press('Shift+ArrowUp');
  await expect.poll(selectedCount).toBeLessThan(fullRange);
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(selectedCount).toBe(fullRange);

  // Cmd/ctrl-click drops one member back out.
  await skillRow(page, `Project/${names[1]}/`).click({ modifiers: ['ControlOrMeta'] });

  const moveRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/skill/move-scope') && req.method() === 'POST') {
      const body = req.postDataJSON() as { name?: string; toScope?: string } | null;
      if (body?.name) moveRequests.push(`${body.name}:${body.toScope}`);
    }
  });

  // Drag a held member: the WHOLE selection moves. Native HTML5 drag events
  // are synthesized composed so they reach the shadow-root listeners — the
  // exact events the browser dispatches for a real mouse drag.
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

  // The drag dispatches ONE scope move per still-selected member — the
  // cmd-untoggled row must not ride along. Asserted at the network seam: the
  // e2e harness pins home = contentDir (`configHomedirOverride`), so project
  // and global share physical roots and the server correctly refuses the
  // actual relocation with SAME_STORAGE — the cross-scope move itself is
  // integration-tested where the harness gives the scopes separate homes.
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

  // A fake installed Claude plugin in the harness home: its skills are
  // DETECTED (read-only) rows grouped under the plugin name — the exact shape
  // that used to terminate the range walk after one step.
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

  // Expand the plugin group, then anchor on the first single and sweep to the
  // second: 2 selected.
  await groupRow.click();
  await skillRow(page, 'Project/zz-plug/plug-one/').waitFor({ timeout: 15_000 });
  await skillRow(page, 'Project/aa-nav-a/').click();
  await skillRow(page, 'Project/aa-nav-b/').click({ modifiers: ['Shift'] });
  await expect.poll(selectedPaths).toContain('Project/aa-nav-b/');

  // Keyboard extension crosses INTO the visible read-only plugin rows instead
  // of clamping at the last movable row. Other rows (built-ins) may sit
  // between the singles and the plugin group, so the press count comes from
  // the rendered order rather than an assumed adjacency.
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

  // Dragging the mixed selection fires a scope move for the movable members
  // ONLY — the plugin row rides along visually but never hits the API.
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
  // Leftover managed skills from sibling tests may sit inside the swept range
  // and legitimately move with it — the contract under test is that the
  // movable members fire and the read-only rows NEVER hit the API.
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

  // The single rename flow every surface shares: commit a new name in the
  // Properties field; the tab must morph to the renamed doc (not strand on the
  // deleted source) and the sidebar row must follow.
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
  // The morphed tab is live: a Properties name field reflects the committed
  // rename (two panels can coexist for a frame while the old doc unmounts, so
  // assert on the surviving one rather than a strict single match).
  await expect(page.getByTestId('skill-name-input').last()).toHaveValue('renamed-target');
});

test('skill lifecycle in the .agents home: create, edit, menu rename, menu move', async ({
  page,
  api,
  workerServer,
}) => {
  await api.testReset();
  // With a `.agents/` dir present the harness-neutral hub wins as the default
  // skill home (agentskills.io convention) - the layout real repos like
  // agents-private run, and where the field failures happened. The worker's
  // contentDir is SHARED across this worker's tests and nothing sweeps dot
  // entries, so the finally below deletes the dir - leaking it would silently
  // flip the default skill home for every later spec on the worker.
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

  // EDIT: type into the live editor and require the bytes to land on disk -
  // the persistence half is what a stuck save would silently drop.
  // `:visible` matters: the Activity pool keeps HIDDEN editors mounted
  // (display:none), and a bare .first() can grab one of those - clicks focus
  // nothing and keystrokes vanish.
  const editor = page.locator('.ProseMirror:visible').first();
  await editor.waitFor({ timeout: 15_000 });
  // Click the body TEXT, not the editor surface: the skill doc mounts more
  // than one ProseMirror (an empty auxiliary editor takes focus on a bare
  // surface click) and keystrokes follow the focus, not the click target.
  await editor.getByText('Lifecycle').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('Edited body line');
  // The keystrokes reached the live doc...
  await expect(editor).toContainText('Edited body line');
  // ...and the persistence debounce flushed them to the canonical file.
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

  // RENAME via the three-dot/context menu dialog (the second rename surface -
  // Properties-field rename is covered by its own spec).
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('lifecycle-renamed');
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await skillRow(page, 'Project/lifecycle-renamed/').waitFor({ timeout: 15_000 });
  await expect(skillRow(page, 'Project/lifecycle-skill/')).toHaveCount(0);
  // The open tab followed the rename instead of stranding.
  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 20_000,
    })
    .toContain('lifecycle-renamed');

  // MOVE via the menu path (drag covers the other path). Asserted at the
  // network seam: the harness pins home = contentDir so the scopes share
  // physical roots and the server refuses the actual relocation.
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

  // Delay every skills-LIST response: the field failure mode is a monorepo
  // where /api/skills takes seconds, so every list snapshot the reconciler
  // sees lags the create - exactly the window where the fresh tab used to be
  // closed as "skill not in the list".
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

  // The created skill's editor opens...
  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 20_000,
    })
    .toContain('auto-open-new');

  // ...and STAYS open across the delayed list snapshots that used to close
  // it. Wait until at least two lagged responses have landed (the stale one
  // that triggered the old close, plus a fresh one), then re-assert.
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

  // Import server-side while the page is live - the CLI / another window /
  // an agent does exactly this, and the sidebar picks the new row up from the
  // files signal.
  const imp = await fetch(`${workerServer.baseURL}/api/skill/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: sourceDir, skill: name, scope: 'project', install: false }),
  });
  expect(imp.ok).toBe(true);

  // ONE click on the freshly appeared row must open it - the dead-row shape
  // was: click swallowed by remount churn or stranded on a stale ignored
  // flag, working only after clicking some other skill first.
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
  // Open a - its live doc is ACTIVE, the exact shape that deadlocked the
  // delete (server unload vs the renderer's instant re-auth on close).
  await rowA.click();
  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 15_000,
    })
    .toContain('bulk-del-a');

  // cmd-click gathers the open skill plus two others.
  await rowA.click({ modifiers: ['ControlOrMeta'] });
  await skillRow(page, 'Project/bulk-del-b/').click({ modifiers: ['ControlOrMeta'] });
  await skillRow(page, 'Project/bulk-del-c/').click({ modifiers: ['ControlOrMeta'] });

  await page.keyboard.press('Delete');
  const dialog = page.getByRole('alertdialog');
  await dialog.waitFor({ timeout: 10_000 });
  await dialog.getByRole('button', { name: /delete/i }).click();

  // The whole batch lands: rows gone, server agrees.
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
  // A local bundle stands in for the skills.sh listing, same as the explore
  // spec. The import is the ONLY mutation: the row must appear off the
  // import's own client push. The watcher cannot deliver it - the new dir
  // sits outside its coverage until the deferred ignore rebuild reconciles
  // (~2 minutes) - which is exactly how the imported-skill row silently
  // never appeared in a live session.
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
  // And the row is not just visible but alive: one click opens the doc.
  await row.click();
  await expect
    .poll(async () => decodeURIComponent(await page.evaluate(() => window.location.hash)), {
      timeout: 15_000,
    })
    .toContain(name);
  rmSync(sourceDir, { recursive: true, force: true });
});
