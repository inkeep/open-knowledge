import { AGENT_REGISTRY } from '@inkeep/open-knowledge-core';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './_helpers';

function connectedApplyBody(): unknown {
  const satisfiers: Record<string, { state: string }> = {};
  for (const agent of Object.values(AGENT_REGISTRY)) {
    for (const satisfier of agent.satisfiers) {
      if (satisfier.probe.mode === 'probeable') satisfiers[satisfier.id] = { state: 'satisfied' };
    }
  }
  return {
    actions: [],
    conflicts: [],
    withheld: [],
    snapshot: {
      probes: { env: 'local-web', satisfiers },
      detection: { detected: Object.keys(AGENT_REGISTRY), probed: true },
    },
  };
}

const CATALOG_BODY = {
  agents: [
    {
      id: 'sweep-alpha',
      name: 'Sweep Alpha',
      version: '1.0.0',
      source: 'registry',
      supported: true,
      featured: false,
      harness: { cli: 'claude', availability: 'present', credentials: 'present' },
    },
    {
      id: 'sweep-beta',
      name: 'Sweep Beta',
      version: '1.0.0',
      source: 'registry',
      supported: true,
      featured: false,
      harness: { cli: 'codex', availability: 'present', credentials: 'present' },
    },
  ],
  stale: true,
  maxThreads: 8,
};

async function openAgentsSettings(page: Page): Promise<Locator> {
  await page.route('**/api/agent-integrations/apply', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(connectedApplyBody()),
    }),
  );
  await page.route('**/api/acp/catalog', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(CATALOG_BODY),
    }),
  );

  await page.goto('/#settings/agent-connections');
  const section = page.getByTestId('settings-configure-agents');
  await expect(section).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('agent-connection-lm-studio')).toBeVisible({
    timeout: 15_000,
  });
  return section;
}

async function controlsMissingAccessibleName(section: Locator): Promise<number> {
  const controls = section.getByRole('switch').or(section.getByRole('button'));
  const total = await controls.count();
  let missing = 0;
  for (let index = 0; index < total; index += 1) {
    try {
      await expect(controls.nth(index)).toHaveAccessibleName(/\S/, { timeout: 2_000 });
    } catch {
      missing += 1;
    }
  }
  return missing;
}

test.describe('merged Agents settings — every control keeps a readable label', () => {
  test('every switch and button on the page has a non-empty accessible name', async ({ page }) => {
    const section = await openAgentsSettings(page);

    await expect(section.getByRole('switch').nth(2)).toBeVisible();
    await expect(section.getByRole('button').nth(2)).toBeVisible();

    expect(await controlsMissingAccessibleName(section)).toBe(0);
  });

  test('the sweep goes red when a control label is blanked', async ({ page }) => {
    const section = await openAgentsSettings(page);
    expect(await controlsMissingAccessibleName(section)).toBe(0);

    await section
      .getByRole('button')
      .first()
      .evaluate((element) => {
        element.textContent = '';
        element.removeAttribute('aria-label');
        element.removeAttribute('aria-labelledby');
        element.removeAttribute('title');
      });

    expect(await controlsMissingAccessibleName(section)).toBeGreaterThanOrEqual(1);
  });

  test('no two action buttons share an accessible name', async ({ page }) => {
    const section = await openAgentsSettings(page);
    const buttons = section.getByRole('button');
    await expect(buttons.nth(2)).toBeVisible();

    const names: string[] = [];
    for (let index = 0; index < (await buttons.count()); index += 1) {
      const name = (
        (await buttons.nth(index).getAttribute('aria-label')) ??
        (await buttons.nth(index).textContent()) ??
        ''
      ).trim();
      if (name !== '') names.push(name);
    }

    const duplicated = names.filter((name, index) => names.indexOf(name) !== index);
    expect(duplicated, `duplicate accessible names: ${duplicated.join(', ')}`).toEqual([]);
    expect(names.length).toBeGreaterThanOrEqual(3);
  });
});
