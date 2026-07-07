/**
 * <Tabs> component strip — exactly one pill per real Tab, never one per nested
 * nodeview.
 *
 * Regression guard for the user-reported "6 pills instead of 2" on the
 * quickstart: a Tab is itself a PM container with its own contentDOM, so any
 * nested nodeview inside a Tab (a Steps and its Steps, a Callout, an Image, a
 * nested Tabs) renders its own `[data-node-view-content-react] > .react-renderer`.
 * `readTabSlots`'s recursive DOM walk swept those grandchildren into the strip
 * slot count, emitting a phantom pill per nested nodeview. The strip must show
 * one pill per real Tab.
 *
 * This is the browser-level companion to the unit coverage in
 * `packages/app/src/editor/components/Tabs.dom.test.tsx`: that test pins
 * `readTabSlots` over a hand-built nodeview DOM; this one proves the real
 * Tiptap render of the `<Tabs><Tab><Steps>…` shape produces the scoped slot
 * count end-to-end.
 */

import { randomUUID } from 'node:crypto';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

// Mirrors the quickstart's Tab 1 NESTING structure (docs/content/get-started/
// quickstart.mdx): a Callout sibling to a multi-Step Steps, alongside a plain
// second Tab. Pre-fix this rendered Tab 1, Tab 2, the Callout, the Steps, and
// every Step as strip pills. Labels are authored explicitly with `label=` here
// because the slot-count regression is label-independent; the quickstart's
// actual Fumadocs `items=`-driven labels are a separate follow-up and are not
// exercised by this test.
const NESTED_TABS_MD = `<Tabs>

<Tab label="macOS app">

<Callout type="info" title="Prerequisites">
macOS on Apple Silicon.
</Callout>

<Steps>

<Step>

### Install the desktop app

</Step>

<Step>

### Create a new project

</Step>

<Step>

### Initialize a knowledge base

</Step>

<Step>

### Open with your AI agent

</Step>

</Steps>

</Tab>

<Tab label="Web app">

Just open the web app in your browser.

</Tab>

</Tabs>`;

test.describe('Tabs component strip', () => {
  test('renders one strip pill per Tab when a Tab nests Steps and a Callout', async ({
    page,
    api,
  }) => {
    // Matches the proven setupDoc pattern: a
    // unique .md doc per test, seeded via replaceDoc, opened by hash route.
    const docName = `tabs-strip-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await api.replaceDoc(docName, NESTED_TABS_MD);
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    // The strip's tablist holds one role="tab" pill per slot; the `+` add-tab
    // affordance is a sibling auxiliary button, not a tab, so it is excluded.
    const pills = page.locator('.tabs-tablist [role="tab"]');
    await expect(pills).toHaveCount(2, { timeout: 10_000 });
    await expect(pills.nth(0)).toHaveText('macOS app');
    await expect(pills.nth(1)).toHaveText('Web app');
  });
});
