import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

function agentId(label: string): string {
  return `${label}-${crypto.randomUUID().slice(0, 8)}`;
}

test.describe('Activity mode (DocPanel) — avatar drill-in, back-arrow exit', () => {
  test('AC-T1: clicking an agent avatar flips DocPanel to agent mode with correct file list', async ({
    page,
    api,
  }) => {
    const docA = 'panel-t1-a';
    const docB = 'panel-t1-b';
    const docView = 'panel-t1-view';
    await api.seedDocs([
      { name: docView, markdown: '# view' },
      { name: docA, markdown: '# a' },
      { name: docB, markdown: '# b' },
    ]);

    await page.goto(`/#/${docView}`);
    await waitForProvider(page);

    const claude = agentId('claude-t1');
    await api.writeAsAgent(docA, '# Claude wrote to A', {
      agentId: claude,
      agentName: 'Claude T1',
      clientName: 'claude-code',
    });
    await api.writeAsAgent(docB, '# Claude also wrote to B', {
      agentId: claude,
      agentName: 'Claude T1',
      clientName: 'claude-code',
    });

    const bar = page.locator('[data-slot="presence-bar"]');

    const claudeAvatar = bar
      .locator('[data-presence-badge="agent"][aria-label*="Claude T1"]')
      .first();
    await expect(claudeAvatar).toBeVisible({ timeout: 10_000 });
    await claudeAvatar.click();

    const backButton = page.locator('[data-testid="docpanel-exit-agent-mode"]');
    await expect(backButton).toBeVisible({ timeout: 5_000 });

    const panel = page.locator('[data-testid="activity-panel"]');
    await expect(panel).toBeVisible({ timeout: 5_000 });

    const fileRows = panel.locator('[data-testid="activity-panel-file-row"]');
    await expect
      .poll(async () => fileRows.count(), { timeout: 10_000, intervals: [100, 250, 500] })
      .toBeGreaterThanOrEqual(2);

    const rowTexts = await fileRows.allInnerTexts();
    expect(rowTexts.some((t) => t.includes(docA))).toBe(true);
    expect(rowTexts.some((t) => t.includes(docB))).toBe(true);

    await expect(claudeAvatar).toHaveAttribute('data-presence-scoped', 'true');
  });

  test('AC-T2: clicking the same avatar a second time exits back to doc mode', async ({
    page,
    api,
  }) => {
    const docView = 'panel-t2-view';
    const docAgent = 'panel-t2-agent';
    await api.seedDocs([
      { name: docView, markdown: '# view' },
      { name: docAgent, markdown: '# body' },
    ]);
    await page.goto(`/#/${docView}`);
    await waitForProvider(page);

    const claude = agentId('claude-t2');
    await api.writeAsAgent(docAgent, '# Claude', {
      agentId: claude,
      agentName: 'Claude T2',
      clientName: 'claude-code',
    });

    const claudeAvatar = page
      .locator('[data-slot="presence-bar"] [data-presence-badge="agent"][aria-label*="Claude T2"]')
      .first();
    await expect(claudeAvatar).toBeVisible({ timeout: 10_000 });

    const backButton = page.locator('[data-testid="docpanel-exit-agent-mode"]');
    const panel = page.locator('[data-testid="activity-panel"]');

    await claudeAvatar.click();
    await expect(backButton).toBeVisible({ timeout: 5_000 });
    await expect(panel).toBeVisible();

    await claudeAvatar.click();
    await expect(backButton).toBeHidden({ timeout: 5_000 });
    await expect(panel).toBeHidden();
  });

  test('AC-T3: back-arrow button exits agent mode; tooltip copy is descriptive', async ({
    page,
    api,
  }) => {
    const docView = 'panel-t3-view';
    const docAgent = 'panel-t3-agent';
    await api.seedDocs([
      { name: docView, markdown: '# view' },
      { name: docAgent, markdown: '# body' },
    ]);
    await page.goto(`/#/${docView}`);
    await waitForProvider(page);

    const claude = agentId('claude-t3');
    await api.writeAsAgent(docAgent, '# Claude', {
      agentId: claude,
      agentName: 'Claude T3',
      clientName: 'claude-code',
    });

    const claudeAvatar = page
      .locator('[data-slot="presence-bar"] [data-presence-badge="agent"][aria-label*="Claude T3"]')
      .first();
    await expect(claudeAvatar).toBeVisible({ timeout: 10_000 });
    await claudeAvatar.click();

    const backButton = page.locator('[data-testid="docpanel-exit-agent-mode"]');
    await expect(backButton).toBeVisible({ timeout: 5_000 });
    await expect(backButton).toHaveAccessibleName(/\S/);

    await backButton.click();
    const panel = page.locator('[data-testid="activity-panel"]');
    await expect(panel).toBeHidden({ timeout: 5_000 });
    await expect(backButton).toBeHidden();
  });

  test('AC-T6 (was AC-P3): filename click navigates main editor; panel stays in agent mode', async ({
    page,
    api,
  }) => {
    const docView = 'panel-t6-view';
    const docTarget = 'panel-t6-target';
    await api.seedDocs([
      { name: docView, markdown: '# view' },
      { name: docTarget, markdown: '# target body' },
    ]);
    await page.goto(`/#/${docView}`);
    await waitForProvider(page);

    const claude = agentId('claude-t6');
    await api.writeAsAgent(docTarget, '# Claude wrote target', {
      agentId: claude,
      agentName: 'Claude T6',
      clientName: 'claude-code',
    });

    const claudeAvatar = page
      .locator('[data-slot="presence-bar"] [data-presence-badge="agent"][aria-label*="Claude T6"]')
      .first();
    await expect(claudeAvatar).toBeVisible({ timeout: 10_000 });
    await claudeAvatar.click();

    const panel = page.locator('[data-testid="activity-panel"]');
    await expect(panel).toBeVisible({ timeout: 5_000 });

    const filenameBtn = panel
      .locator('[data-testid="activity-panel-file-row-filename"]')
      .filter({ hasText: docTarget })
      .first();
    await expect(filenameBtn).toBeVisible({ timeout: 5_000 });
    await filenameBtn.click();

    await expect
      .poll(async () => page.url(), {
        timeout: 5_000,
        intervals: [100, 250, 500],
      })
      .toContain(`#/${docTarget}`);
    const backButton = page.locator('[data-testid="docpanel-exit-agent-mode"]');
    await expect(backButton).toBeVisible();
    await expect(panel).toBeVisible();
  });

  test('AC-P4 (carryover): undo does not move main editor active doc', async ({ page, api }) => {
    const docView = 'panel-t7-view';
    const docAgent = 'panel-t7-agent';
    await api.seedDocs([
      { name: docView, markdown: `# view\n\n${Array(40).fill('filler line').join('\n\n')}` },
      { name: docAgent, markdown: '# agent body' },
    ]);
    await page.goto(`/#/${docView}`);
    await waitForProvider(page);

    const claude = agentId('claude-t7');
    await api.writeAsAgent(docAgent, '# Claude wrote burst 1', {
      agentId: claude,
      agentName: 'Claude T7',
      clientName: 'claude-code',
    });

    const urlBefore = page.url();

    const claudeAvatar = page
      .locator('[data-slot="presence-bar"] [data-presence-badge="agent"][aria-label*="Claude T7"]')
      .first();
    await expect(claudeAvatar).toBeVisible({ timeout: 10_000 });
    await claudeAvatar.click();
    const panel = page.locator('[data-testid="activity-panel"]');
    await expect(panel).toBeVisible({ timeout: 5_000 });

    const row = panel.locator('[data-testid="activity-panel-file-row"]').first();
    await row.locator('[data-testid="activity-panel-file-row-carrot"]').click();
    const undoLast = panel.locator('[data-testid="activity-panel-undo-last"]');
    await expect(undoLast).toBeVisible({ timeout: 5_000 });
    await undoLast.click();

    await expect
      .poll(async () => page.url(), { timeout: 2_000, intervals: [100, 250, 500] })
      .toBe(urlBefore);
    const backButton = page.locator('[data-testid="docpanel-exit-agent-mode"]');
    await expect(backButton).toBeVisible();
  });
});
