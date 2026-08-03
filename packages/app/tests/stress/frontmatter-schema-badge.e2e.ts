/**
 * Playwright E2E for how frontmatter-schema violations report in WYSIWYG.
 *
 * A frontmatter violation has no body construct to mark. The validator anchors
 * a missing-`required` error to the frontmatter region's opening fence, so on a
 * document with no frontmatter at all it lands on line 1 — the first line of
 * body text, which is not what is wrong. These tests pin the two halves of the
 * resulting contract: the body stays unmarked, and the error reports on the
 * toolbar's Add-properties button instead (the only affordance still present
 * when a doc has zero properties and `PropertyPanel` renders nothing).
 *
 * Every fixture carries a markdownlint violation alongside the frontmatter one.
 * That is deliberate: "the frontmatter error marked nothing" asserted against a
 * body with no violations at all would also pass if the decoration pass never
 * ran (or the schema never loaded). Pinning the body to exactly ONE marked
 * block — the markdownlint one — makes the pass prove it ran before it proves
 * what it declined to mark.
 *
 * The last test pins decoration stability across a block-move round trip by
 * following which block index carries the mark, which is the observable a
 * "the squiggly vanished" report comes down to.
 *
 * Requires: Playwright browsers installed. Dev server started by
 * playwright.config.ts webServer on VITE_PORT (or default 5173).
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  type ApiHelpers,
  expect,
  filterCriticalErrors,
  type LogEntry,
  test,
  waitForActiveProviderSynced as waitForProvider,
} from './_helpers';

/** The hard tab trips markdownlint MD010 — a genuinely body-anchored rule. */
const TAB_LINE = '\tindented with a hard tab';
/** No frontmatter at all → the schema's `required` fires with nothing to anchor to. */
const NO_FRONTMATTER_BODY = `# Heading\n\nfirst paragraph\n\n${TAB_LINE}\n`;
/** Both required properties present; `status` is not in the schema's enum. */
const INVALID_ENUM_BODY = `---\nstatus: shipped\nowner: sam\n---\n\n# Heading\n\nfirst paragraph\n\n${TAB_LINE}\n`;
/** One property present but wrong, one required property absent — one of each. */
const MIXED_BODY = `---\nstatus: shipped\n---\n\n# Heading\n\nfirst paragraph\n\n${TAB_LINE}\n`;
/** Same shape, schema-conformant. */
const CONFORMANT_BODY = `---\nstatus: draft\nowner: sam\n---\n\n# Heading\n\nfirst paragraph\n\n${TAB_LINE}\n`;

const errors: LogEntry[] = [];
let testDocName = '';

const addPropertiesButton = (page: Page) => page.getByTestId('add-properties-button');
/** Missing required properties — reported on the toolbar's Add-properties button. */
const missingBadge = (page: Page) => page.getByTestId('add-properties-problem-badge');
/** Present-but-invalid properties — reported on the Properties disclosure count. */
const invalidBadge = (page: Page) => page.getByTestId('property-problem-badge');
const decoratedBlocks = (page: Page) =>
  page.locator('.ProseMirror:not(.composer-prosemirror) > .ok-lint-block');

/**
 * Index of the marked top-level block among the editor's children, or -1 when
 * nothing is marked. A positional read (rather than a count) is what makes the
 * move round trip observable: the mark has to leave one index and arrive at
 * another for the assertions to advance.
 */
const markedBlockIndex = (page: Page) =>
  page.evaluate(() => {
    const editor = document.querySelector('.ProseMirror:not(.composer-prosemirror)');
    if (!editor) return -1;
    return Array.from(editor.children).findIndex((child) =>
      child.classList.contains('ok-lint-block'),
    );
  });

/** Seed the doc and wait for the body to arrive (lint settles under each assertion). */
async function seed(page: Page, api: ApiHelpers, markdown: string) {
  await api.replaceDoc(testDocName, markdown);
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toContainText('hard tab', {
    timeout: 15_000,
  });
}

test.beforeEach(async ({ page, api, workerServer }) => {
  mkdirSync(join(workerServer.contentDir, '.ok', 'schemas'), { recursive: true });
  writeFileSync(
    join(workerServer.contentDir, '.ok', 'schemas', 'doc.schema.json'),
    JSON.stringify({
      type: 'object',
      required: ['status', 'owner'],
      properties: { status: { enum: ['draft', 'review', 'published'] } },
    }),
    'utf-8',
  );
  writeFileSync(
    join(workerServer.contentDir, '.ok', 'config.yml'),
    [
      'contentRules:',
      '  markdownlint:',
      '    enabled: true',
      '  frontmatter:',
      '    enabled: true',
      '    schemas:',
      '      - file: .ok/schemas/doc.schema.json',
      '',
    ].join('\n'),
    'utf-8',
  );
  errors.length = 0;
  page.on('pageerror', (err) => errors.push({ type: 'uncaught', text: err.message }));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const loc = msg.location();
      errors.push({ type: 'error', text: msg.text(), url: loc.url, line: loc.lineNumber });
    }
  });

  testDocName = `fmbadge-${randomUUID().slice(0, 8)}`;
  await api.createPage(`${testDocName}.md`);
  await page.goto(`/#/${testDocName}`);
  await waitForProvider(page);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
});

test.afterEach(() => {
  expect(filterCriticalErrors(errors), 'Expected zero critical console errors').toEqual([]);
});

test.afterAll(({ workerServer }) => {
  // Restore the default (both plugins off) so any e2e sharing this worker isn't
  // left with the linter silently enabled.
  writeFileSync(join(workerServer.contentDir, '.ok', 'config.yml'), '', 'utf-8');
});

test.describe('frontmatter schema violations in WYSIWYG', () => {
  test('a doc missing required frontmatter marks the tab block only, never the heading', async ({
    page,
    api,
  }) => {
    await seed(page, api, NO_FRONTMATTER_BODY);
    // The badge witnesses the schema loaded and the violation is live.
    await expect(missingBadge(page)).toBeVisible();
    // Exactly one mark, and it is markdownlint's — the frontmatter violation's
    // line-1 anchor used to add a second one on the heading.
    await expect(decoratedBlocks(page)).toHaveCount(1);
    await expect(decoratedBlocks(page).first()).toContainText('hard tab');
  });

  test('missing properties report on the Add-properties button', async ({ page, api }) => {
    await seed(page, api, NO_FRONTMATTER_BODY);
    // Both `status` and `owner` are absent.
    await expect(missingBadge(page)).toHaveText('2');
    // The count reaches assistive tech through the button's own name — the
    // badge is aria-hidden.
    await expect(addPropertiesButton(page)).toHaveAttribute(
      'aria-label',
      /2 required properties missing/,
    );
    // With no frontmatter there are no properties, so the panel — and its own
    // badge — do not render at all.
    await expect(invalidBadge(page)).toHaveCount(0);
  });

  test('a present-but-invalid property reports on the Properties count, not the button', async ({
    page,
    api,
  }) => {
    await seed(page, api, INVALID_ENUM_BODY);
    // `status: shipped` exists and is wrong — adding a property is not its fix.
    await expect(invalidBadge(page)).toHaveText('1');
    // The accessible name sits on the focusable tooltip trigger; the badge
    // inside it is aria-hidden decoration.
    await expect(page.getByTestId('property-problem-badge-trigger')).toHaveAttribute(
      'aria-label',
      /1 property does not match the schema/,
    );
    await expect(missingBadge(page)).toHaveCount(0);
    // And the body is still left alone.
    await expect(decoratedBlocks(page)).toHaveCount(1);
    await expect(decoratedBlocks(page).first()).toContainText('hard tab');
  });

  test('one of each lands on its own affordance', async ({ page, api }) => {
    // `status: shipped` is present and wrong; `owner` is absent. This is the
    // case a single shared badge would collapse into one indistinct number.
    await seed(page, api, MIXED_BODY);
    await expect(invalidBadge(page)).toHaveText('1');
    await expect(missingBadge(page)).toHaveText('1');
  });

  test('both badges clear once the frontmatter satisfies the schema', async ({ page, api }) => {
    // Start violating so the clear is a transition rather than an initial
    // state a never-loaded schema would also produce.
    await seed(page, api, MIXED_BODY);
    await expect(invalidBadge(page)).toBeVisible();
    await expect(missingBadge(page)).toBeVisible();

    await api.replaceDoc(testDocName, CONFORMANT_BODY);
    await expect(invalidBadge(page)).toHaveCount(0);
    await expect(missingBadge(page)).toHaveCount(0);
    await expect(addPropertiesButton(page)).toHaveAttribute('aria-label', 'Add properties');
    // The body rule is untouched by the frontmatter fix.
    await expect(decoratedBlocks(page)).toHaveCount(1);
  });
});

test.describe('body-anchored decorations survive block reordering', () => {
  test('the mark follows its block up and back down again', async ({ page, api }) => {
    await seed(page, api, NO_FRONTMATTER_BODY);
    // blocks: 0 heading, 1 paragraph, 2 tab block (+ trailing empty paragraph)
    await expect.poll(() => markedBlockIndex(page), { timeout: 15_000 }).toBe(2);

    // Drive the block-mover through a synthetic keydown rather than
    // page.keyboard: Cmd+Shift+Arrow is claimed by the OS/browser on some
    // platforms, and the harness needs the shortcut to reach ProseMirror.
    const moveMarkedBlock = (direction: 'up' | 'down') =>
      page.evaluate((dir) => {
        const editor = window.__activeEditor;
        if (!editor) throw new Error('no active editor');
        let target = -1;
        editor.state.doc.forEach((node, offset) => {
          if (node.textContent.includes('hard tab')) target = offset;
        });
        if (target < 0) throw new Error('marked block not found');
        editor.commands.focus();
        editor.commands.setTextSelection(target + 1);
        // The binding is `Mod-Shift-Arrow*`, and ProseMirror resolves `Mod` to
        // Meta on macOS but Ctrl everywhere else. A hardcoded `metaKey` matches
        // nothing on the Linux CI runner — the block simply never moves and the
        // assertion reads as a decoration bug rather than a wrong keystroke.
        const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
        editor.view.dom.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: dir === 'up' ? 'ArrowUp' : 'ArrowDown',
            metaKey: isMac,
            ctrlKey: !isMac,
            shiftKey: true,
            bubbles: true,
          }),
        );
      }, direction);

    await moveMarkedBlock('up');
    await expect.poll(() => markedBlockIndex(page), { timeout: 15_000 }).toBe(1);

    await moveMarkedBlock('down');
    await expect.poll(() => markedBlockIndex(page), { timeout: 15_000 }).toBe(2);
    await expect(decoratedBlocks(page)).toHaveCount(1);
    await expect(decoratedBlocks(page).first()).toContainText('hard tab');
  });
});
