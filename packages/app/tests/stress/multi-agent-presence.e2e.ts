import { expect, test, waitForActiveProviderSynced } from './_helpers';

function agentId(label: string): string {
  return `${label}-${crypto.randomUUID().slice(0, 8)}`;
}

test.describe('multi-agent presence — sectioned PresenceBar (FR-9)', () => {
  test('two distinct agents on the same doc render as two badges (bug-bash repro)', async ({
    page,
    api,
  }) => {
    const docFoo = 'doc-mp-foo';
    await api.seedDocs([{ name: docFoo, markdown: '# foo' }]);

    await page.goto(`/#/${docFoo}`);
    await waitForActiveProviderSynced(page);
    const bar = page.locator('[data-slot="presence-bar"]');

    const claudeId = agentId('claude');
    const cursorId = agentId('cursor');
    await Promise.all([
      api.writeAsAgent(docFoo, '# Claude was here', {
        agentId: claudeId,
        agentName: 'Claude',
        clientName: 'claude-code',
      }),
      api.writeAsAgent(docFoo, '# Cursor was here', {
        agentId: cursorId,
        agentName: 'Cursor',
        clientName: 'cursor',
      }),
    ]);

    const currentSection = bar.locator('[data-presence-section="current"]');
    await expect
      .poll(
        async () => ({
          claude: await currentSection
            .locator('[data-presence-badge="agent"][aria-label="Open activity panel for Claude"]')
            .count(),
          cursor: await currentSection
            .locator('[data-presence-badge="agent"][aria-label="Open activity panel for Cursor"]')
            .count(),
        }),
        { timeout: 10_000, intervals: [100, 250, 500] },
      )
      .toEqual({ claude: 1, cursor: 1 });
  });

  test('cross-doc agent renders in dimmed section with divider', async ({ page, api }) => {
    const docFoo = 'doc-mp-cross-foo';
    const docBar = 'doc-mp-cross-bar';
    await api.seedDocs([
      { name: docFoo, markdown: '# foo' },
      { name: docBar, markdown: '# bar' },
    ]);

    await page.goto(`/#/${docFoo}`);
    const bar = page.locator('[data-slot="presence-bar"]');

    await api.writeAsAgent(docFoo, '# Claude on foo', {
      agentId: agentId('claude-foo'),
      agentName: 'Claude',
      clientName: 'claude-code',
    });
    await api.writeAsAgent(docBar, '# Cursor on bar', {
      agentId: agentId('cursor-bar'),
      agentName: 'Cursor',
      clientName: 'cursor',
    });

    const currentSection = bar.locator('[data-presence-section="current"]');
    const crossDocSection = bar.locator('[data-presence-section="crossdoc"]');

    await expect
      .poll(
        async () => ({
          claude: await currentSection
            .locator('[data-presence-badge="agent"][aria-label*="Claude"]')
            .count(),
          cursor: await crossDocSection
            .locator('[data-presence-badge="agent"][aria-label*="Cursor"]')
            .count(),
        }),
        { timeout: 10_000, intervals: [100, 250, 500] },
      )
      .toEqual({ claude: 1, cursor: 1 });

    const crossAvatar = crossDocSection.locator(
      '[data-presence-badge="agent"][aria-label*="Cursor"]',
    );
    await expect(crossAvatar.first()).toHaveAttribute('data-presence-crossdoc', 'true');
  });

  test('clicking the cross-doc avatar opens the Activity Panel (D-P9 LOCKED replaces nav)', async ({
    page,
    api,
  }) => {
    const docFoo = 'doc-mp-nav-foo';
    const docBar = 'doc-mp-nav-bar';
    await api.seedDocs([
      { name: docFoo, markdown: '# foo' },
      { name: docBar, markdown: '# bar body' },
    ]);

    await page.goto(`/#/${docFoo}`);
    const bar = page.locator('[data-slot="presence-bar"]');

    await api.writeAsAgent(docFoo, '# Claude on foo', {
      agentId: agentId('claude-nav-foo'),
      agentName: 'Claude',
      clientName: 'claude-code',
    });
    await api.writeAsAgent(docBar, '# Cursor on bar', {
      agentId: agentId('cursor-nav-bar'),
      agentName: 'Cursor',
      clientName: 'cursor',
    });

    const crossDocAvatar = bar.locator(
      '[data-presence-section="crossdoc"] [data-presence-badge="agent"][data-presence-crossdoc="true"]',
      { hasText: '' },
    );
    await expect(crossDocAvatar.first()).toBeVisible({ timeout: 10_000 });
    await api.writeAsAgent(docBar, '# Cursor on bar', {
      agentId: agentId('cursor-nav-bar'),
      agentName: 'Cursor',
      clientName: 'cursor',
    });
    await crossDocAvatar.first().click();

    const panel = page.locator('[data-testid="activity-panel"]');
    await expect(panel).toBeVisible({ timeout: 10_000 });
    expect(page.url()).toContain(`#/${docFoo}`);
    expect(page.url()).not.toContain(`#/${docBar}`);
  });

  test('clicking a cross-doc avatar with NO doc selected navigates then opens the panel', async ({
    page,
    api,
  }) => {
    const docBar = 'doc-mp-nodoc-bar';
    await api.seedDocs([{ name: docBar, markdown: '# bar body' }]);

    await page.goto('/');
    const bar = page.locator('[data-slot="presence-bar"]');
    const panel = page.locator('[data-testid="activity-panel"]');

    expect(page.url()).not.toContain(`#/${docBar}`);
    await expect(panel).toBeHidden();

    await api.writeAsAgent(docBar, '# Cursor on bar', {
      agentId: agentId('cursor-nodoc-bar'),
      agentName: 'Cursor',
      clientName: 'cursor',
    });

    const crossDocAvatar = bar.locator(
      '[data-presence-section="crossdoc"] [data-presence-badge="agent"][data-presence-crossdoc="true"]',
    );
    await expect(crossDocAvatar.first()).toBeVisible({ timeout: 10_000 });
    await api.writeAsAgent(docBar, '# Cursor on bar', {
      agentId: agentId('cursor-nodoc-bar'),
      agentName: 'Cursor',
      clientName: 'cursor',
    });
    await crossDocAvatar.first().click();

    await expect.poll(() => page.url()).toContain(`#/${docBar}`);
    await expect(panel).toBeVisible({ timeout: 10_000 });
  });
});
