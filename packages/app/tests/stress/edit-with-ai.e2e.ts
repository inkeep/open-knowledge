
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';
import {
  type HandoffMockConfig,
  installHandoffMocks,
  readCapturedHandoff,
} from './fixtures/handoff-mocks';

const PROSE = 'The quick brown fox jumps over the lazy dog and keeps on running.';

function webCfg(workerServer: { baseURL: string; contentDir: string }): HandoffMockConfig {
  return {
    host: 'web',
    install: { claude: true, codex: true, cursor: true },
    workerBaseURL: workerServer.baseURL,
    workerContentDir: workerServer.contentDir,
  };
}

async function seedAndOpenWysiwyg(
  page: Page,
  api: { seedDocs: (docs: Array<{ name: string; markdown: string }>) => Promise<void> },
  docName: string,
  markdown: string,
): Promise<void> {
  await api.seedDocs([{ name: docName, markdown }]);
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await page.waitForSelector('.ProseMirror');
}

async function selectFirstParagraph(page: Page): Promise<void> {
  await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    if (!pm) throw new Error('no ProseMirror');
    const p = pm.querySelector('p');
    if (!p?.firstChild) throw new Error('no paragraph text node');
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}

async function openSelectionAskAiMenu(page: Page) {
  await page.getByTestId('edit-with-ai-bubble-button').click();
  const popover = page.getByTestId('edit-with-ai-popover');
  await expect(popover).toBeVisible();
  return popover;
}

async function openSourceSelectionAskAiMenu(page: Page, shortcut: string) {
  await page.getByRole('radio', { name: /Markdown source/i }).click();
  const source = page.locator('.cm-content').first();
  await expect(source).toBeVisible({ timeout: 10_000 });
  await source.focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press(shortcut);
  const menu = page.getByTestId('open-in-agent-menu');
  await expect(menu).toBeVisible();
  return menu;
}

async function pickAskAiTarget(page: Page, target: 'claude-code' | 'codex' | 'cursor') {
  await page.getByTestId(`edit-with-ai-target-${target}`).click();
}

async function pickSourceAskAiTarget(page: Page, target: 'claude-code' | 'codex' | 'cursor') {
  await page.getByTestId(`open-in-agent-item-${target}`).click();
}

test.describe('Edit with AI — affordance + deep-link dispatch (live app)', () => {
  test('QA-001/004/026: WYSIWYG bubble shows Edit-with-AI button on a text selection, after the link control, and dispatches a well-formed deep-link', async ({
    page,
    api,
    workerServer,
  }) => {
    await installHandoffMocks(page, webCfg(workerServer));
    await seedAndOpenWysiwyg(page, api, 'qa-ewai-wysiwyg', `# Heading\n\n${PROSE}`);

    await selectFirstParagraph(page);

    const btn = page.getByTestId('edit-with-ai-bubble-button');
    await expect(btn).toBeVisible({ timeout: 10_000 });

    const placement = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="bubble-menu-bar"]');
      const ai = bar?.querySelector('[data-testid="edit-with-ai-bubble-button"]');
      const link = bar?.querySelector('[aria-label="Insert link"]');
      const linkPrecedesAi =
        ai && link
          ? Boolean(ai.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_PRECEDING)
          : false;
      return {
        label: ai?.textContent?.trim() ?? '',
        hasSparkle: Boolean(ai?.querySelector('svg')),
        aiAfterLink: linkPrecedesAi,
        linkPresent: Boolean(link),
      };
    });
    expect(placement.label).toContain('Edit with AI');
    expect(placement.hasSparkle).toBe(true);
    expect(placement.linkPresent).toBe(true);
    expect(placement.aiAfterLink).toBe(true);

    await openSelectionAskAiMenu(page);
    await pickAskAiTarget(page, 'claude-code');

    await expect
      .poll(async () => (await readCapturedHandoff(page)).handoffApiCalls.length, {
        timeout: 5_000,
      })
      .toBe(1);
    const call = (await readCapturedHandoff(page)).handoffApiCalls[0];
    expect(call?.target).toBe('claude-code');
    const url = call?.url ?? '';
    expect(url.length).toBeLessThanOrEqual(4096);
    const q = new URL(url).searchParams.get('q') ?? '';
    expect(q).toContain('@qa-ewai-wysiwyg.md');
    expect(q).toContain('quick brown fox'); // the selected passage, inlined
    expect(q).toContain('```'); // fenced inline block
  });

  test('source mode Cmd+Shift+I opens the shared Ask AI menu and dispatches the selected source', async ({
    page,
    api,
    workerServer,
  }) => {
    await installHandoffMocks(page, webCfg(workerServer));
    await seedAndOpenWysiwyg(page, api, 'qa-ewai-source-shortcut', `# Heading\n\n${PROSE}`);

    await openSourceSelectionAskAiMenu(page, 'Meta+Shift+I');
    await pickSourceAskAiTarget(page, 'claude-code');

    await expect
      .poll(async () => (await readCapturedHandoff(page)).handoffApiCalls.length, {
        timeout: 5_000,
      })
      .toBe(1);
    const call = (await readCapturedHandoff(page)).handoffApiCalls[0];
    expect(call?.target).toBe('claude-code');
    const q = new URL(call?.url ?? '').searchParams.get('q') ?? '';
    expect(q).toContain('@qa-ewai-source-shortcut.md');
    expect(q).toContain('# Heading');
    expect(q).toContain('quick brown fox');
  });

  test('WYSIWYG Cmd+Shift+I opens the selection popover for the selected passage', async ({
    page,
    api,
    workerServer,
  }) => {
    await installHandoffMocks(page, webCfg(workerServer));
    await seedAndOpenWysiwyg(page, api, 'qa-ewai-wysiwyg-shortcut', `# Heading\n\n${PROSE}`);
    await selectFirstParagraph(page);

    await page.keyboard.press('ControlOrMeta+Shift+I');
    await expect(page.getByTestId('edit-with-ai-popover')).toBeVisible();
    await pickAskAiTarget(page, 'claude-code');

    await expect
      .poll(async () => (await readCapturedHandoff(page)).handoffApiCalls.length, {
        timeout: 5_000,
      })
      .toBe(1);
    const call = (await readCapturedHandoff(page)).handoffApiCalls[0];
    expect(call?.target).toBe('claude-code');
    const q = new URL(call?.url ?? '').searchParams.get('q') ?? '';
    expect(q).toContain('@qa-ewai-wysiwyg-shortcut.md');
    expect(q).toContain('quick brown fox');
  });

  test('QA-009: no bubble button when there is no selection', async ({
    page,
    api,
    workerServer,
  }) => {
    await installHandoffMocks(page, webCfg(workerServer));
    await seedAndOpenWysiwyg(page, api, 'qa-ewai-nosel', `# H\n\n${PROSE}`);
    await page.evaluate(() => {
      const sel = window.getSelection();
      sel?.removeAllRanges();
    });
    await expect(page.getByTestId('edit-with-ai-bubble-button')).toHaveCount(0);
  });

  test('QA-010: affordance hidden on a non-macOS host (platform spoofed to Linux)', async ({
    page,
    api,
    workerServer,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', {
        get: () => 'Linux x86_64',
        configurable: true,
      });
    });
    await installHandoffMocks(page, webCfg(workerServer));
    await seedAndOpenWysiwyg(page, api, 'qa-ewai-linux', `# H\n\n${PROSE}`);
    await selectFirstParagraph(page);
    await expect(page.getByTestId('bubble-menu-bar')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('edit-with-ai-bubble-button')).toHaveCount(0);
  });

  test('QA-011: no Edit-with-AI button on an image node selection (node controls instead)', async ({
    page,
    api,
    workerServer,
  }) => {
    await installHandoffMocks(page, webCfg(workerServer));
    await seedAndOpenWysiwyg(
      page,
      api,
      'qa-ewai-image',
      `# H\n\n![alt text](https://example.com/x.png)\n\n${PROSE}`,
    );
    await page.waitForFunction(() => Boolean(window.__activeEditor), null, { timeout: 5_000 });
    const nodeSelected = await page.evaluate(() => {
      const ed = window.__activeEditor;
      if (!ed) return { ok: false, name: null as string | null };
      let imgPos = -1;
      let imgName: string | null = null;
      ed.state.doc.descendants(
        (
          node: { isAtom?: boolean; type: { name: string }; attrs?: { componentName?: string } },
          pos: number,
        ) => {
          if (imgPos !== -1) return false;
          const n = node.type.name;
          const isImage =
            n === 'jsxComponent' &&
            (node.attrs?.componentName === 'img' ||
              node.attrs?.componentName === 'CommonMarkImage' ||
              node.attrs?.componentName === 'Embed');
          if (isImage) {
            imgPos = pos;
            imgName = `${n}:${node.attrs?.componentName}`;
            return false;
          }
          return true;
        },
      );
      if (imgPos === -1) return { ok: false, name: null };
      ed.chain().focus().setNodeSelection(imgPos).run();
      return { ok: true, name: imgName };
    });
    expect(nodeSelected.ok).toBe(true);
    await expect(page.getByTestId('edit-with-ai-bubble-button')).toHaveCount(0);
  });

  test('QA-012: selection popover shows installed agents and no claude.ai/web fallback row', async ({
    page,
    api,
    workerServer,
  }) => {
    await installHandoffMocks(page, webCfg(workerServer));
    await seedAndOpenWysiwyg(page, api, 'qa-ewai-agents', `# H\n\n${PROSE}`);
    await selectFirstParagraph(page);
    const popover = await openSelectionAskAiMenu(page);

    await expect(page.getByTestId('edit-with-ai-target-claude-code')).toBeVisible();
    await expect(page.getByTestId('edit-with-ai-target-codex')).toBeVisible();
    await expect(page.getByTestId('edit-with-ai-target-cursor')).toBeVisible();
    await expect(page.getByTestId('edit-with-ai-target-claude-cowork')).toHaveCount(0);
    const bodyText = await popover.innerText();
    expect(bodyText.toLowerCase()).not.toContain('claude.ai');
  });

  test('QA-013: typed instruction appears in the dispatched prompt', async ({
    page,
    api,
    workerServer,
  }) => {
    await installHandoffMocks(page, webCfg(workerServer));
    await seedAndOpenWysiwyg(page, api, 'qa-ewai-instr', `# H\n\n${PROSE}`);
    await selectFirstParagraph(page);
    await openSelectionAskAiMenu(page);
    await page.getByTestId('edit-with-ai-instruction').fill('tighten the prose');
    await pickAskAiTarget(page, 'codex');

    await expect
      .poll(async () => (await readCapturedHandoff(page)).handoffApiCalls.length, {
        timeout: 5_000,
      })
      .toBe(1);
    const call = (await readCapturedHandoff(page)).handoffApiCalls[0];
    expect(call?.target).toBe('codex');
    const prompt = new URL(call?.url ?? '').searchParams.get('prompt') ?? '';
    expect(prompt).toContain('@qa-ewai-instr.md');
    expect(prompt).toContain('quick brown fox');
    expect(prompt).toContain('Instruction:');
    expect(prompt).toContain('tighten the prose');
  });

  test('QA-013b: dispatch allowed with empty instruction (no instruction text in prompt)', async ({
    page,
    api,
    workerServer,
  }) => {
    await installHandoffMocks(page, webCfg(workerServer));
    await seedAndOpenWysiwyg(page, api, 'qa-ewai-noinstr', `# H\n\n${PROSE}`);
    await selectFirstParagraph(page);
    await openSelectionAskAiMenu(page);
    await pickAskAiTarget(page, 'codex');

    await expect
      .poll(async () => (await readCapturedHandoff(page)).handoffApiCalls.length, {
        timeout: 5_000,
      })
      .toBe(1);
    const call = (await readCapturedHandoff(page)).handoffApiCalls[0];
    expect(call?.target).toBe('codex');
    const prompt = new URL(call?.url ?? '').searchParams.get('prompt') ?? '';
    expect(prompt).toContain('@qa-ewai-noinstr.md');
    expect(prompt).toContain('quick brown fox');
    expect(prompt).toContain('Here is the passage:');
    expect(prompt).not.toContain('Instruction:');
  });

  test('QA-024: selection popover shows pending then empty-install copy when no agents installed', async ({
    page,
    api,
    workerServer,
  }) => {
    const cfg: HandoffMockConfig = {
      host: 'web',
      install: { claude: false, codex: false, cursor: false },
      workerBaseURL: workerServer.baseURL,
      workerContentDir: workerServer.contentDir,
    };
    await installHandoffMocks(page, cfg);
    await seedAndOpenWysiwyg(page, api, 'qa-ewai-empty', `# H\n\n${PROSE}`);
    await selectFirstParagraph(page);
    await openSelectionAskAiMenu(page);
    const empty = page.getByTestId('edit-with-ai-empty');
    await expect(empty).toBeVisible();
    const txt = await empty.innerText();
    expect(/Checking for installed agents|No installed agents found/.test(txt)).toBe(true);
    await expect(page.getByTestId('edit-with-ai-target-claude-code')).toHaveCount(0);
  });

  test('QA-027: selection popover opens from keyboard activation', async ({
    page,
    api,
    workerServer,
  }) => {
    await installHandoffMocks(page, webCfg(workerServer));
    await seedAndOpenWysiwyg(page, api, 'qa-ewai-a11y', `# H\n\n${PROSE}`);
    await selectFirstParagraph(page);
    const btn = page.getByTestId('edit-with-ai-bubble-button');
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await btn.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('edit-with-ai-popover')).toBeVisible();
    await expect(page.getByTestId('edit-with-ai-target-claude-code')).toBeVisible();
  });

  test('QA-028: Escape closes the selection popover without dispatching and with no error toast', async ({
    page,
    api,
    workerServer,
  }) => {
    await installHandoffMocks(page, webCfg(workerServer));
    await seedAndOpenWysiwyg(page, api, 'qa-ewai-dismiss', `# H\n\n${PROSE}`);
    await selectFirstParagraph(page);
    await openSelectionAskAiMenu(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('edit-with-ai-popover')).toHaveCount(0);
    const captured = await readCapturedHandoff(page);
    expect(captured.handoffApiCalls).toEqual([]);
    await expect(page.getByText(/Couldn't reach/)).toHaveCount(0);
  });

  test('QA-014: dispatched passage is the snapshot taken at menu-open, not the live selection', async ({
    page,
    api,
    workerServer,
  }) => {
    await installHandoffMocks(page, webCfg(workerServer));
    await seedAndOpenWysiwyg(
      page,
      api,
      'qa-ewai-snapshot',
      `# H\n\n${PROSE}\n\nA completely different second paragraph here.`,
    );
    await page.waitForFunction(() => Boolean(window.__activeEditor), null, { timeout: 5_000 });
    await selectFirstParagraph(page);
    await openSelectionAskAiMenu(page);
    await page.evaluate(() => {
      const ed = window.__activeEditor;
      if (!ed) return;
      const size = ed.state.doc.content.size;
      ed.chain()
        .setTextSelection({ from: Math.max(1, size - 20), to: size - 1 })
        .run();
    });
    await pickAskAiTarget(page, 'claude-code');
    await expect
      .poll(async () => (await readCapturedHandoff(page)).handoffApiCalls.length, {
        timeout: 5_000,
      })
      .toBe(1);
    const q =
      new URL((await readCapturedHandoff(page)).handoffApiCalls[0]?.url ?? '').searchParams.get(
        'q',
      ) ?? '';
    expect(q).toContain('quick brown fox');
    expect(q).not.toContain('completely different second paragraph');
  });

  test('QA-020: web host records no telemetry line for a selection dispatch', async ({
    page,
    api,
    workerServer,
  }) => {
    await installHandoffMocks(page, webCfg(workerServer));
    await seedAndOpenWysiwyg(page, api, 'qa-ewai-webtel', `# H\n\n${PROSE}`);
    await selectFirstParagraph(page);
    await openSelectionAskAiMenu(page);
    await pickAskAiTarget(page, 'claude-code');
    await expect
      .poll(async () => (await readCapturedHandoff(page)).handoffApiCalls.length, {
        timeout: 5_000,
      })
      .toBe(1);
    const captured = await readCapturedHandoff(page);
    expect(captured.recordHandoffCalls).toEqual([]);
    const isWeb = await page.evaluate(() => (window as { okDesktop?: unknown }).okDesktop == null);
    expect(isWeb).toBe(true);
  });
});

test.describe('Edit with AI — Electron telemetry + retry (live app)', () => {
  function electronCfg(workerServer: { baseURL: string; contentDir: string }): HandoffMockConfig {
    return {
      host: 'electron',
      install: { claude: true, codex: true, cursor: true },
      workerBaseURL: workerServer.baseURL,
      workerContentDir: workerServer.contentDir,
    };
  }

  test("QA-019: Electron selection dispatch records scope:'selection'", async ({
    page,
    api,
    workerServer,
  }) => {
    await installHandoffMocks(page, electronCfg(workerServer));
    await seedAndOpenWysiwyg(page, api, 'qa-ewai-eltel', `# H\n\n${PROSE}`);
    await selectFirstParagraph(page);
    await openSelectionAskAiMenu(page);
    await pickAskAiTarget(page, 'claude-code');

    await expect
      .poll(async () => (await readCapturedHandoff(page)).recordHandoffCalls.length, {
        timeout: 5_000,
      })
      .toBe(1);
    const line = (await readCapturedHandoff(page)).recordHandoffCalls[0];
    expect(line?.host).toBe('electron');
    expect(line?.scope).toBe('selection');
    expect(line?.outcome).toBe('ok');
  });

  test('QA-022: failed selection dispatch surfaces an error toast with a Retry action', async ({
    page,
    api,
    workerServer,
  }) => {
    await installHandoffMocks(page, electronCfg(workerServer));
    await page.unroute('**/api/handoff');
    await page.route('**/api/handoff', async (route) => {
      await route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        body: JSON.stringify({ status: 422, title: 'not installed' }),
      });
    });
    await seedAndOpenWysiwyg(page, api, 'qa-ewai-retry', `# H\n\n${PROSE}`);
    await selectFirstParagraph(page);
    await openSelectionAskAiMenu(page);
    await pickAskAiTarget(page, 'claude-code');

    await expect(page.getByText("Couldn't reach Claude — try again?")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  });
});
