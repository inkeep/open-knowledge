import { expectDocumentOpen, test } from './_helpers';

test('a document opens in a browser that lacks Promise.withResolvers', async ({ page, api }) => {
  const docName = `no-with-resolvers-${Date.now().toString(36)}`;
  await api.seedDocs([{ name: docName, markdown: `# ${docName}\n\nBody text.\n` }]);
  await page.addInitScript(() => {
    Reflect.deleteProperty(Promise, 'withResolvers');
  });

  await page.goto(`/#/${docName}`);

  await expectDocumentOpen(page, docName);
});
