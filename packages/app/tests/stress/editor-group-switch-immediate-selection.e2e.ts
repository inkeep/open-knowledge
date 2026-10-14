import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { afterEditorFocusSync, expect, test, waitForActiveProviderSynced } from './_helpers';

const fixtureSuffix = '7bc247b7';
const lineEndKey = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End';
const documentEndKey = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';

function paneTabs(page: Page): Locator {
  return page.locator('[data-editor-header-tabs] [data-editor-pane-tabs]');
}

async function paneIds(page: Page): Promise<string[]> {
  return paneTabs(page).evaluateAll((strips) =>
    strips.flatMap((strip) => {
      const id = strip.getAttribute('data-editor-pane-tabs');
      return id ? [id] : [];
    }),
  );
}

function editorForDoc(page: Page, docName: string): Locator {
  return page.locator(
    `[data-editor-activity-mount][data-doc-name="${docName}"] .ProseMirror:not(.composer-prosemirror)`,
  );
}

async function openDocFromSidebar(page: Page, docName: string): Promise<void> {
  await page
    .locator('[data-slot="sidebar-container"]')
    .getByRole('treeitem', { name: `${docName}.md`, exact: true })
    .click();
  await waitForActiveProviderSynced(page);
  const tab = page.locator(
    `[data-editor-pane-focused] [data-editor-tab-sortable][data-editor-tab-id="${docName}"]`,
  );
  if ((await tab.getAttribute('data-preview-tab')) === 'true') {
    await tab.click({ button: 'right' });
    await page.getByTestId('editor-tab-context-keep-open').click();
  }
}

async function dragTabToRightEdge(page: Page, tab: Locator, paneId: string): Promise<void> {
  const tabBox = await tab.boundingBox();
  if (!tabBox) throw new Error('tab has no box');
  await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(tabBox.x + tabBox.width / 2 + 12, tabBox.y + tabBox.height / 2, {
    steps: 2,
  });
  const edge = page.locator(`section[data-editor-pane-id="${paneId}"] [data-pane-edge="right"]`);
  await expect(edge).toBeAttached();
  const edgeBox = await edge.boundingBox();
  if (!edgeBox) throw new Error('edge has no box');
  await page.mouse.move(edgeBox.x + edgeBox.width / 2, edgeBox.y + edgeBox.height / 2, {
    steps: 8,
  });
  await expect(edge).toHaveAttribute('data-pane-drop-side', 'right');
  await page.mouse.up();
}

async function readDocument(page: Page, docName: string): Promise<string> {
  const response = await page.request.get(`/api/document?docName=${encodeURIComponent(docName)}`);
  expect(response.ok()).toBe(true);
  const result = (await response.json()) as { content: string };
  return result.content;
}

async function readActiveYText(page: Page): Promise<string | null> {
  return page.evaluate(
    () => window.__activeProvider?.document.getText('source').toString() ?? null,
  );
}

async function selectionSnapshot(page: Page) {
  return page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) return null;
    const selection = editor.state.selection;
    const dom = window.getSelection();
    const editorElement = editor.editorView?.dom ?? null;
    return {
      time: performance.now(),
      anchor: selection.anchor,
      head: selection.head,
      anchorOffset: selection.$anchor.parentOffset,
      headOffset: selection.$head.parentOffset,
      fromOffset: selection.$from.parentOffset,
      toOffset: selection.$to.parentOffset,
      domAnchorOffset: dom?.anchorOffset ?? -1,
      domFocusOffset: dom?.focusOffset ?? -1,
      domSelectedText: dom?.toString() ?? '',
      activeDocName: window.__activeProvider?.configuration.name ?? null,
      editorFocused:
        editorElement !== null &&
        (document.activeElement === editorElement ||
          editorElement.contains(document.activeElement)),
      editorPaneId: editorElement
        ?.closest('[data-editor-pane-id]')
        ?.getAttribute('data-editor-pane-id'),
      editorInert: editorElement?.closest('[inert]') !== null,
      paneInert: document
        .querySelector('[data-slot="pane-card"][data-pane="editor"]')
        ?.hasAttribute('inert'),
    };
  });
}

for (const projection of ['wide', 'narrow'] as const) {
  test(
    projection === 'narrow'
      ? 'five consecutive ShiftLeft selections survive a group switch'
      : 'wide four-pane physical-key control survives a tab switch',
    async ({ page, api, workerServer }, testInfo) => {
      const evidenceDir = testInfo.outputDir;
      const id = randomUUID().slice(0, 8);
      const labels = ['alpha', 'bravo', 'charlie', 'delta'];
      const docs = labels.map((label) => ({
        name: `qa002-${label}-${id}`,
        markdown: `# ${label}-${id}\n\n${label} body\n\n${Array.from({ length: 70 }, (_, index) => `${label} paragraph ${index}`).join('\n\n')}`,
      }));
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      mkdirSync(join(evidenceDir, 'screenshots'), { recursive: true });
      mkdirSync(join(evidenceDir, 'videos'), { recursive: true });
      try {
        await api.seedDocs(docs);
        await page.setViewportSize({ width: 2400, height: 900 });
        await page.goto(`/#/${docs[0].name}`);
        await waitForActiveProviderSynced(page);

        for (const doc of docs.slice(1)) {
          await page
            .locator('[data-editor-pane-focused] [data-editor-pane-tabs]')
            .getByTestId('editor-new-tab-button')
            .click();
          await openDocFromSidebar(page, doc.name);
          const ids = await paneIds(page);
          const paneId = ids.at(-1);
          if (!paneId) throw new Error('missing focused pane');
          const tab = page.locator(
            `[data-editor-pane-tabs="${paneId}"] [data-editor-tab-sortable][data-editor-tab-id="${doc.name}"]`,
          );
          await dragTabToRightEdge(page, tab, paneId);
          await expect(paneTabs(page)).toHaveCount(ids.length + 1);
        }

        const ids = await paneIds(page);
        expect(ids).toHaveLength(4);
        await editorForDoc(page, docs[1].name).locator('p').last().click();
        await afterEditorFocusSync(page);
        await page.keyboard.press(lineEndKey);
        await page.keyboard.type(` isolated-${fixtureSuffix}`);
        await expect
          .poll(() => readDocument(page, docs[1].name))
          .toContain(`bravo paragraph 69 isolated-${fixtureSuffix}`);

        await page.setViewportSize({ width: projection === 'narrow' ? 767 : 2400, height: 800 });
        const selector = page.getByRole('combobox', { name: 'Editor pane' });
        if (projection === 'narrow') await expect(selector).toBeVisible();
        const selectPane = async (index: number) => {
          if (projection === 'narrow') {
            await selector.click();
            await page.getByRole('option', { name: `Pane ${index + 1}` }).click();
          } else {
            await page
              .locator(
                `[data-editor-pane-tabs="${ids[index]}"] [data-editor-tab-sortable][data-editor-tab-id="${docs[index].name}"]`,
              )
              .click();
          }
        };
        for (const [index, doc] of docs.entries()) {
          await selectPane(index);
          await editorForDoc(page, doc.name).locator('p').last().click();
          await afterEditorFocusSync(page);
          await page.keyboard.press(documentEndKey);
          await page.keyboard.type(` group-${index}-${fixtureSuffix}`);
          await expect
            .poll(() => readDocument(page, doc.name))
            .toContain(`group-${index}-${fixtureSuffix}`);
        }

        await selectPane(1);
        await editorForDoc(page, docs[1].name).locator('p').last().click();
        await afterEditorFocusSync(page);
        await page.keyboard.press(documentEndKey);
        await expect
          .poll(() => selectionSnapshot(page))
          .toMatchObject({ anchorOffset: 53, headOffset: 53, domSelectedText: '' });
        const before = await selectionSnapshot(page);
        console.log(
          JSON.stringify({
            stage: 'initial-caret',
            before,
            bravo: await readDocument(page, docs[1].name),
          }),
        );
        expect(before).toMatchObject({ anchorOffset: 53, headOffset: 53, domSelectedText: '' });

        const siblingBaseline = await Promise.all(
          docs.filter((_, index) => index !== 1).map((doc) => readDocument(page, doc.name)),
        );
        const originalBravo = await readDocument(page, docs[1].name);

        await page.evaluate((captureProjection) => {
          const events: unknown[] = [];
          Object.assign(window, { __qa002Events: events });
          const initialEditor = window.__activeEditor;
          let shiftLeftKeyups = 0;
          let firstSwitchPointerdown = false;
          let firstFocusout = false;
          const capture = (type: string, key?: string, eventTimeStamp?: number) => {
            const editor = window.__activeEditor;
            const selection = editor?.state.selection;
            const dom = window.getSelection();
            const editorElement = editor?.editorView?.dom ?? null;
            events.push({
              type,
              key,
              time: performance.now(),
              eventTimeStamp,
              anchor: selection?.anchor,
              head: selection?.head,
              anchorOffset: selection?.$anchor.parentOffset,
              headOffset: selection?.$head.parentOffset,
              domAnchorOffset: dom?.anchorOffset,
              domFocusOffset: dom?.focusOffset,
              domSelectedText: dom?.toString(),
              editorIsInitial: editor === initialEditor,
              editorDocName: editor?.storage.collaboration?.document?.guid ?? null,
              editorFocused:
                editorElement !== null &&
                (document.activeElement === editorElement ||
                  editorElement.contains(document.activeElement)),
              editorPaneId: editorElement
                ?.closest('[data-editor-pane-id]')
                ?.getAttribute('data-editor-pane-id'),
              editorInert: editorElement?.closest('[inert]') !== null,
              paneInert: document
                .querySelector('[data-slot="pane-card"][data-pane="editor"]')
                ?.hasAttribute('inert'),
            });
          };
          document.addEventListener(
            'keydown',
            (event) => capture('keydown', event.key, event.timeStamp),
            true,
          );
          document.addEventListener(
            'keyup',
            (event) => {
              if (event.key === 'ArrowLeft' && event.shiftKey) shiftLeftKeyups += 1;
              capture(
                shiftLeftKeyups === 5 && event.key === 'ArrowLeft' && event.shiftKey
                  ? 'fifth-keyup'
                  : 'keyup',
                event.key,
                event.timeStamp,
              );
            },
            true,
          );
          document.addEventListener('selectionchange', () => capture('selectionchange'), true);
          document.addEventListener(
            'pointerdown',
            (event) => {
              if (shiftLeftKeyups < 5 || firstSwitchPointerdown) return;
              if (!(event.target instanceof Element)) return;
              const target =
                captureProjection === 'narrow'
                  ? event.target.closest('[role="combobox"]')
                  : event.target.closest('[data-editor-tab-sortable]');
              if (target === null) return;
              firstSwitchPointerdown = true;
              capture('first-switch-pointerdown', undefined, event.timeStamp);
            },
            true,
          );
          document.addEventListener(
            'focusout',
            (event) => {
              if (shiftLeftKeyups < 5 || firstFocusout) return;
              firstFocusout = true;
              capture('first-focusout', undefined, event.timeStamp);
            },
            true,
          );
          initialEditor?.on('selectionUpdate', () => capture('selectionUpdate'));
        }, projection);

        for (let index = 0; index < 5; index++) await page.keyboard.press('Shift+ArrowLeft');
        const immediatelyAfterFive = await selectionSnapshot(page);
        expect(immediatelyAfterFive).toMatchObject({ domSelectedText: '247b7' });
        await expect
          .poll(() => selectionSnapshot(page))
          .toMatchObject({
            anchorOffset: 53,
            headOffset: 48,
            fromOffset: 48,
            toOffset: 53,
            domSelectedText: '247b7',
          });
        await selectPane(0);
        await selectPane(1);
        const afterSwitch = await selectionSnapshot(page);
        await editorForDoc(page, docs[1].name).focus();
        const afterFocus = await selectionSnapshot(page);
        const eventTrace = await page.evaluate(
          () => (window as Window & { __qa002Events?: unknown[] }).__qa002Events ?? [],
        );
        const matchesFive = (snapshot: Awaited<ReturnType<typeof selectionSnapshot>>) =>
          snapshot?.anchorOffset === 53 &&
          snapshot.headOffset === 48 &&
          snapshot.fromOffset === 48 &&
          snapshot.toOffset === 53 &&
          snapshot.domSelectedText === '247b7';
        const firstDivergence = !matchesFive(immediatelyAfterFive)
          ? 'immediately-after-fifth-key'
          : !matchesFive(afterSwitch)
            ? 'after-group-return-before-focus'
            : !matchesFive(afterFocus)
              ? 'after-group-return-and-focus'
              : null;
        console.log(
          JSON.stringify({
            stage: 'after-switch',
            projection,
            firstDivergence,
            before,
            immediatelyAfterFive,
            afterSwitch,
            afterFocus,
            eventTrace,
            pageErrors,
          }),
        );
        await test.info().attach(`group-switch-selection-${projection}-selection-timing.json`, {
          body: JSON.stringify({
            projection,
            firstDivergence,
            before,
            immediatelyAfterFive,
            afterSwitch,
            afterFocus,
            eventTrace,
            docs: docs.map((doc) => doc.name),
            pageErrors,
          }),
          contentType: 'application/json',
        });
        expect(afterFocus).toMatchObject({
          anchorOffset: 53,
          headOffset: 48,
          fromOffset: 48,
          toOffset: 53,
          domSelectedText: '247b7',
        });
        await page.keyboard.type('Z');
        await page.screenshot({
          path: join(
            evidenceDir,
            'screenshots',
            `group-switch-selection-${projection}-five-shift-after-switch.png`,
          ),
          fullPage: true,
        });
        await expect
          .poll(() => readDocument(page, docs[1].name))
          .toContain(`bravo paragraph 69 isolated-${fixtureSuffix} group-1-7bcZ`);
        const replacedBravo = await readDocument(page, docs[1].name);
        expect(replacedBravo).not.toContain(`group-1-${fixtureSuffix}`);
        await expect.poll(() => readActiveYText(page)).toContain('group-1-7bcZ');
        await expect
          .poll(() => readFileSync(join(workerServer.contentDir, `${docs[1].name}.md`), 'utf8'))
          .toContain('group-1-7bcZ');
        await page.keyboard.press('ControlOrMeta+z');
        await expect.poll(() => readDocument(page, docs[1].name)).toBe(originalBravo);
        await expect.poll(() => readActiveYText(page)).toBe(originalBravo);
        for (const [index, doc] of docs.filter((_, index) => index !== 1).entries()) {
          expect(await readDocument(page, doc.name)).toBe(siblingBaseline[index]);
        }
        await page.screenshot({
          path: join(
            evidenceDir,
            'screenshots',
            `group-switch-selection-${projection}-five-shift-after-undo.png`,
          ),
          fullPage: true,
        });
        console.log(
          JSON.stringify({
            stage: 'complete',
            projection,
            before,
            immediatelyAfterFive,
            afterSwitch,
            afterFocus,
            originalBravo,
            replacedBravo,
            siblingBaseline,
            pageErrors,
          }),
        );
        expect(pageErrors).toEqual([]);
      } finally {
        const video = page.video();
        await page.close();
        if (video)
          copyFileSync(
            await video.path(),
            join(evidenceDir, 'videos', `group-switch-selection-${projection}-five-shift.webm`),
          );
      }
    },
  );
}
