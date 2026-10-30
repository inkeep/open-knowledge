import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

const NOTES_DOC = 'diagram-tabs-notes';
const DIAGRAMS_DOC = 'diagram-tabs-diagrams';
const FLOW_DOC = 'diagram-tabs-flow.mmd';

const DIAGRAMS_MARKDOWN = [
  '# Diagrams',
  '',
  '```mermaid',
  'flowchart TD',
  '  A[Draft] --> B[Review]',
  '  B --> C[Publish]',
  '```',
  '',
  '```mermaid',
  'sequenceDiagram',
  '  Alice->>Bob: Hello',
  '  Bob-->>Alice: Hi',
  '```',
  '',
].join('\n');

const FLOW_SOURCE = 'flowchart LR\n  A[Plan] --> B[Build] --> C[Ship]\n';

type KeptDiagrams = { __keptDiagrams?: Record<string, Element[]> };

function readyDiagrams(docName: string): string {
  return `[data-ok-activity-host="${docName}"] [data-component-type="mermaid"].mermaid-ready .mw-svg-host > svg`;
}

function editorTab(page: Page, name: string | RegExp) {
  return page.getByRole('main').getByRole('button', { name, exact: true });
}

async function openTabs(page: Page, openTabs: string[], activeTabId: string): Promise<void> {
  await page.addInitScript(
    ({ tabs, active }) => {
      window.localStorage.setItem(
        `ok-editor-tabs-v1:${window.location.origin}`,
        JSON.stringify({
          updatedAt: '2026-10-27T00:00:00.000Z',
          panes: [
            { id: 'pane-main', openTabs: tabs, pinnedTabIds: [], activeTabId: active, size: 100 },
          ],
          focusedPaneId: 'pane-main',
        }),
      );
    },
    { tabs: openTabs, active: activeTabId },
  );
}

async function keepDiagrams(page: Page, docName: string): Promise<void> {
  await page.evaluate(
    ({ selector, key }) => {
      const scope = window as unknown as KeptDiagrams;
      scope.__keptDiagrams = {
        ...scope.__keptDiagrams,
        [key]: Array.from(document.querySelectorAll(selector)),
      };
    },
    { selector: readyDiagrams(docName), key: docName },
  );
}

async function showsKeptDiagrams(page: Page, docName: string): Promise<boolean> {
  return page.evaluate(
    ({ selector, key }) => {
      const kept = (window as unknown as KeptDiagrams).__keptDiagrams?.[key] ?? [];
      const shown = Array.from(document.querySelectorAll(selector));
      return (
        kept.length > 0 && shown.length === kept.length && shown.every((svg, i) => svg === kept[i])
      );
    },
    { selector: readyDiagrams(docName), key: docName },
  );
}

test('switching back to a tab shows the diagrams it already rendered', async ({
  page,
  api,
  workerServer,
}) => {
  await api.seedDocs([
    { name: NOTES_DOC, markdown: '# Notes\n\nPlain text.\n' },
    { name: DIAGRAMS_DOC, markdown: DIAGRAMS_MARKDOWN },
  ]);
  writeFileSync(join(workerServer.contentDir, FLOW_DOC), FLOW_SOURCE, 'utf-8');
  await openTabs(page, [NOTES_DOC, DIAGRAMS_DOC], NOTES_DOC);
  await page.goto(`/#/${NOTES_DOC}`);
  await waitForActiveProviderSynced(page);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));

  await editorTab(page, `${DIAGRAMS_DOC}.md`).click();
  await expect(page.locator(readyDiagrams(DIAGRAMS_DOC))).toHaveCount(2);
  await keepDiagrams(page, DIAGRAMS_DOC);

  await page
    .locator('[data-slot="sidebar-container"]')
    .getByRole('treeitem', { name: FLOW_DOC, exact: true })
    .dblclick();
  await expect(page.locator(readyDiagrams(FLOW_DOC))).toHaveCount(1);
  await keepDiagrams(page, FLOW_DOC);

  await editorTab(page, `${NOTES_DOC}.md`).click();
  await editorTab(page, `${DIAGRAMS_DOC}.md`).click();
  await expect(page.locator(readyDiagrams(DIAGRAMS_DOC))).toHaveCount(2);
  expect(await showsKeptDiagrams(page, DIAGRAMS_DOC)).toBe(true);

  await editorTab(page, `${NOTES_DOC}.md`).click();
  await editorTab(page, /^diagram-tabs-flow\.mmd(\.md)?$/).click();
  await expect(page.locator(readyDiagrams(FLOW_DOC))).toHaveCount(1);
  expect(await showsKeptDiagrams(page, FLOW_DOC)).toBe(true);
});
