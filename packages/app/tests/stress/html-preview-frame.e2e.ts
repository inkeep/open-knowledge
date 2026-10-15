import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

type MessageCounter = Window & { messagesSeen?: number };

function previewMarkdown(probeText: string): string {
  return [
    '# Preview',
    '',
    '```html preview',
    '<div id="probe" style="height: 300px">before</div>',
    '<img src="http://example.invalid/blocked.png" alt="">',
    `<script>document.getElementById('probe').textContent = '${probeText}';</script>`,
    '```',
    '',
  ].join('\n');
}

test('html preview code blocks run scripts, size the frame, report blocked requests and show edits', async ({
  page,
  api,
}) => {
  const docName = `html-preview-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown: previewMarkdown('ran') }]);

  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);

  const frame = page.frameLocator('iframe[title="HTML preview"]');
  await expect(frame.locator('#probe')).toHaveText('ran');

  const preview = page.locator('.ok-codeblock-preview');
  const previewHeight = async () => (await preview.boundingBox())?.height ?? 0;
  await expect.poll(previewHeight, { timeout: 10_000 }).toBeGreaterThan(290);
  await expect.poll(previewHeight, { timeout: 10_000 }).toBeLessThan(400);

  await expect(
    page.getByRole('status').filter({ hasText: 'http://example.invalid/blocked.png' }),
  ).toBeVisible();

  await api.replaceDoc(docName, previewMarkdown('edited'));
  await expect(frame.locator('#probe')).toHaveText('edited');
});

test('a content file at the frame page path does not replace the bundled frame page', async ({
  page,
  api,
  workerServer,
}) => {
  const docName = `html-preview-shadow-${randomUUID().slice(0, 8)}`;
  await api.seedDocs([{ name: docName, markdown: previewMarkdown('ran') }]);
  const contentAssets = join(workerServer.contentDir, 'assets');
  mkdirSync(contentAssets, { recursive: true });
  writeFileSync(join(contentAssets, 'preview-frame.html'), '<!doctype html><p>content file</p>');
  try {
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    await expect(page.frameLocator('iframe[title="HTML preview"]').locator('#probe')).toHaveText(
      'ran',
    );
  } finally {
    rmSync(contentAssets, { recursive: true, force: true });
  }
});

test('the preview frame page ignores documents posted by a parent on another origin', async ({
  page,
  baseURL,
}) => {
  const framePage = `${baseURL}/assets/preview-frame.html`;
  const otherOrigin = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><iframe id="frame" src="${framePage}"></iframe>`);
  });
  const listening = Promise.withResolvers<void>();
  otherOrigin.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  try {
    const { port } = otherOrigin.address() as AddressInfo;
    await page.goto(`http://127.0.0.1:${port}/`);
    const frame = page.frameLocator('#frame');
    await expect(frame.locator('script')).toHaveCount(1);
    const child = page.frames().find((candidate) => candidate.url() === framePage);
    if (!child) throw new Error('Expected the preview frame page to load');
    await child.evaluate(() => {
      addEventListener('message', () => {
        const counter = window as MessageCounter;
        counter.messagesSeen = (counter.messagesSeen ?? 0) + 1;
      });
    });

    await page.evaluate(() => {
      document
        .querySelector('iframe')
        ?.contentWindow?.postMessage({ okPreviewDocument: '<p id="written">written</p>' }, '*');
    });

    await expect
      .poll(() => child.evaluate(() => (window as MessageCounter).messagesSeen ?? 0))
      .toBe(1);
    await expect(frame.locator('#written')).toHaveCount(0);
  } finally {
    const closed = Promise.withResolvers<void>();
    otherOrigin.close(() => closed.resolve());
    await closed.promise;
  }
});
