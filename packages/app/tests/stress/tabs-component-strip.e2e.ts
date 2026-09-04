import { randomUUID } from 'node:crypto';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

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
    const docName = `tabs-strip-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await api.replaceDoc(docName, NESTED_TABS_MD);
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');

    const pills = page.locator('.tabs-tablist [role="tab"]');
    await expect(pills).toHaveCount(2, { timeout: 10_000 });
    await expect(pills.nth(0)).toHaveText('macOS app');
    await expect(pills.nth(1)).toHaveText('Web app');
  });
});
