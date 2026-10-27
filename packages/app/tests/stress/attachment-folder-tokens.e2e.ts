import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  createPngBuffer,
  escapeRegExp,
  expect,
  openPropPanel,
  openSettingsSection,
  test,
  uniqueAssetName,
  waitForActiveProviderSynced,
  waitForImageDecoded,
} from './_helpers';

const EDITOR = '.ProseMirror:not(.composer-prosemirror)';
const PATH_START = 'Folder path must start with ./ or / and cannot contain ..';

function writeProjectConfig(contentDir: string, body: string): void {
  mkdirSync(join(contentDir, '.ok'), { recursive: true });
  writeFileSync(join(contentDir, '.ok', 'config.yml'), body);
}

function readProjectConfig(contentDir: string): string {
  const path = join(contentDir, '.ok', 'config.yml');
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

async function flushConfigWrites(page: Page, contentDir: string): Promise<void> {
  const before = readProjectConfig(contentDir);
  await page.getByTestId('settings-content-rules-log-links').click();
  await expect.poll(() => readProjectConfig(contentDir), { timeout: 10_000 }).not.toBe(before);
}

function writeAttachmentFolderPath(contentDir: string, attachmentFolderPath: string): void {
  writeProjectConfig(contentDir, `content:\n  attachmentFolderPath: '${attachmentFolderPath}'\n`);
}

function savedAttachmentFolderPath(attachmentFolderPath: string): RegExp {
  return new RegExp(`attachmentFolderPath: ['"]?${escapeRegExp(attachmentFolderPath)}['"]?\\n`);
}

async function openDoc(page: Page, docName: string): Promise<void> {
  await page.goto(`/#/${docName}`);
  await page.waitForSelector(EDITOR);
  await waitForActiveProviderSynced(page);
}

async function expectRefusalToast(page: Page): Promise<void> {
  const toast = page
    .locator('[data-sonner-toast]')
    .filter({ hasText: "Couldn't upload the file." });
  await expect(toast).toContainText('unknown variable \u2066{{FILENAME}}\u2069');
  await expect(toast).toContainText('Fix it under Attachments in Settings.');
  await expect(toast).not.toContainText('content.attachmentFolderPath');
}

async function dropPngIntoEditor(page: Page, bytes: Buffer, filename: string): Promise<void> {
  await page.evaluate(
    ({ b, name }) => {
      const editor = document.querySelector<HTMLElement>('.ProseMirror:not(.composer-prosemirror)');
      if (!editor) throw new Error('no editor');
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(b)], name, { type: 'image/png' }));
      const rect = editor.getBoundingClientRect();
      const init = {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
        clientX: rect.left + Math.floor(rect.width / 2),
        clientY: rect.top + Math.floor(rect.height / 2),
      };
      editor.dispatchEvent(new DragEvent('dragover', init));
      editor.dispatchEvent(new DragEvent('drop', init));
    },
    { b: Array.from(bytes), name: filename },
  );
}

async function sourceText(page: Page): Promise<string> {
  return page.evaluate(
    () => window.__activeProvider?.document?.getText('source')?.toString() ?? '',
  );
}

test.describe('Attachment folder path variables', () => {
  let configBefore = '';

  test.beforeEach(({ workerServer }) => {
    configBefore = readProjectConfig(workerServer.contentDir);
  });

  test.afterEach(({ workerServer }) => {
    writeProjectConfig(workerServer.contentDir, configBefore);
  });

  test('with no setting, a dropped image lands in a folder named after its document and renders', async ({
    page,
    api,
    workerServer,
  }) => {
    const runId = randomUUID().slice(0, 8);
    const folder = `tokens-${runId}`;
    const docName = `${folder}/meeting`;
    const assetName = uniqueAssetName('photo.png', runId);
    await api.seedDocs([{ name: docName, markdown: 'Notes\n' }]);
    writeProjectConfig(workerServer.contentDir, '');

    await openDoc(page, docName);
    await page.click(EDITOR);
    await dropPngIntoEditor(page, createPngBuffer(runId), assetName);

    await expect
      .poll(() => sourceText(page), { timeout: 10_000 })
      .toMatch(new RegExp(escapeRegExp(`meeting.assets/${assetName}`)));
    expect(existsSync(join(workerServer.contentDir, folder, 'meeting.assets', assetName))).toBe(
      true,
    );
    await waitForImageDecoded(page.locator(`${EDITOR} img`).first());
  });

  test('a drop under an unknown variable is refused with the problem named in the toast', async ({
    page,
    api,
    workerServer,
  }) => {
    const runId = randomUUID().slice(0, 8);
    const folder = `tokens-${runId}`;
    const docName = `${folder}/meeting`;
    const assetName = uniqueAssetName('photo.png', runId);
    await api.seedDocs([{ name: docName, markdown: 'Notes\n' }]);
    writeAttachmentFolderPath(workerServer.contentDir, './{{FILENAME}}.assets');

    await openDoc(page, docName);
    await page.click(EDITOR);
    await dropPngIntoEditor(page, createPngBuffer(runId), assetName);

    await expectRefusalToast(page);
    expect(existsSync(join(workerServer.contentDir, folder, '{{FILENAME}}.assets'))).toBe(false);
    expect(existsSync(join(workerServer.contentDir, folder, assetName))).toBe(false);
  });

  test('a cover upload under an unknown variable names the problem instead of asking for a retry', async ({
    page,
    api,
    workerServer,
  }) => {
    const runId = randomUUID().slice(0, 8);
    const folder = `tokens-${runId}`;
    const docName = `${folder}/meeting`;
    await api.seedDocs([{ name: docName, markdown: "---\ncover: ''\n---\n\nNotes\n" }]);
    writeAttachmentFolderPath(workerServer.contentDir, './{{FILENAME}}.assets');

    await openDoc(page, docName);
    const upload = page.getByTestId('page-cover-upload');
    await expect(upload).toBeVisible();
    await upload
      .locator('xpath=..')
      .locator('input[type="file"]')
      .setInputFiles({
        name: uniqueAssetName('cover.png', runId),
        mimeType: 'image/png',
        buffer: createPngBuffer(runId),
      });

    const alert = upload.locator('xpath=../..').getByRole('alert');
    await expect(alert).toContainText('\u2066{{FILENAME}}\u2069');
    await expect(alert).toContainText('Fix it under Attachments in Settings.');
    await expect(alert).not.toContainText('content.attachmentFolderPath');
    await expect(alert).not.toContainText('try again');
    expect(existsSync(join(workerServer.contentDir, folder, '{{FILENAME}}.assets'))).toBe(false);
  });

  test('a drop under a hand-edited value that is not a string points to the config file, not the schema reason', async ({
    page,
    api,
    workerServer,
  }) => {
    const runId = randomUUID().slice(0, 8);
    const docName = `tokens-${runId}/meeting`;
    await api.seedDocs([{ name: docName, markdown: 'Notes\n' }]);
    writeProjectConfig(workerServer.contentDir, 'content:\n  attachmentFolderPath:\n');

    await openDoc(page, docName);
    await page.click(EDITOR);
    await dropPngIntoEditor(page, createPngBuffer(runId), uniqueAssetName('photo.png', runId));

    const toast = page
      .locator('[data-sonner-toast]')
      .filter({ hasText: "Couldn't upload the file." });
    await expect(toast).toContainText(
      "The \u2066content.attachmentFolderPath\u2069 value in \u2066.ok/config.yml\u2069 can't be used. Fix it in that file.",
    );
    await expect(toast).not.toContainText('Fix it under Attachments in Settings.');
    await expect(toast).not.toContainText('expected string');
  });

  test('a property panel upload under an unknown variable names the problem in the toast', async ({
    page,
    api,
    workerServer,
  }) => {
    const runId = randomUUID().slice(0, 8);
    const folder = `tokens-${runId}`;
    const docName = `${folder}/gallery`;
    const assetName = uniqueAssetName('photo.png', runId);
    await api.seedDocs([{ name: docName, markdown: '<img src="initial.png" alt="initial" />' }]);
    writeAttachmentFolderPath(workerServer.contentDir, './{{FILENAME}}.assets');

    await openDoc(page, docName);
    const panel = await openPropPanel(page);
    await panel
      .locator('[data-prop-upload-input]')
      .first()
      .setInputFiles({ name: assetName, mimeType: 'image/png', buffer: createPngBuffer(runId) });

    await expectRefusalToast(page);
    expect(existsSync(join(workerServer.contentDir, folder, assetName))).toBe(false);
  });

  test('the settings field flags bad variables and saves typed paths', async ({
    page,
    api,
    workerServer,
  }) => {
    await api.testReset();
    writeAttachmentFolderPath(workerServer.contentDir, './');
    await openSettingsSection(page, 'project-preferences', 'settings-attachments');

    const field = page.getByTestId('settings-attachments-path');
    const fieldError = page.getByTestId('settings-attachments-path-error');
    await expect(field).toHaveValue('./');
    await expect(field).toHaveAccessibleName('Attachments');
    await expect(field).toHaveAccessibleDescription(
      'Set where pasted and dropped files are stored. Example: a file added to notes/meeting.md is saved as notes/image.png',
    );
    const docsLink = page.getByTestId('settings-attachments-title-docs-link');
    await expect(docsLink).toHaveAttribute(
      'href',
      'https://openknowledge.ai/docs/features/assets-and-embeds#attachment-folder',
    );
    const description = await page
      .getByText('Set where pasted and dropped files are stored.')
      .boundingBox();
    const linkBox = await docsLink.boundingBox();
    if (!description || !linkBox)
      throw new Error('The description and its docs link must both be visible.');
    expect(Math.abs(linkBox.y - description.y)).toBeLessThan(4);
    await field.click();
    await field.press('End');
    await field.pressSequentially('{{');
    await expect(field).toHaveValue('./{{');
    await expect(field).toBeFocused();
    await expect(fieldError).toHaveText('Each {{ needs a matching }}.');
    await expect(fieldError).not.toHaveAttribute('role', 'alert');
    await expect(page.getByTestId('settings-attachments-preview')).toHaveCount(0);
    await field.fill('./{{FILENAME}}.assets');
    await expect(
      page.getByTestId('settings-attachments-path-highlight').locator('[data-token="unknown"]'),
    ).toHaveText('{{FILENAME}}');
    await expect(fieldError).toContainText('{{FILENAME}}');
    await field.fill('./{{filename}}-{{filename}}');
    await expect(fieldError).toContainText('Use {{filename}} at most once in each folder name.');
    await expect(fieldError).not.toHaveAttribute('role', 'alert');
    await field.press('Enter');
    await expect(fieldError).toContainText('Use {{filename}} at most once in each folder name.');
    await expect(fieldError).toHaveAttribute('role', 'alert');

    await page.getByTestId('settings-content-rules-log-links').click();
    await expect
      .poll(() => readProjectConfig(workerServer.contentDir), { timeout: 10_000 })
      .toContain('suppressLogLinkAdvisories');
    expect(readProjectConfig(workerServer.contentDir)).toMatch(savedAttachmentFolderPath('./'));

    await field.fill('./{{filename}}.assets');
    await field.press('Enter');
    await expect(
      page.getByTestId('settings-attachments-path-highlight').locator('[data-token="known"]'),
    ).toHaveText('{{filename}}');
    await expect(page.getByTestId('settings-attachments-preview')).toContainText(
      'notes/meeting.assets/',
    );
    await expect
      .poll(() => readProjectConfig(workerServer.contentDir), { timeout: 10_000 })
      .toMatch(savedAttachmentFolderPath('./{{filename}}.assets'));

    await field.fill('/');
    await field.press('Enter');
    await expect
      .poll(() => readProjectConfig(workerServer.contentDir), { timeout: 10_000 })
      .toMatch(savedAttachmentFolderPath('/'));

    await field.fill('attachments');
    await field.press('Enter');
    await expect(fieldError).toHaveText(PATH_START);
    await expect(field).toHaveAccessibleDescription(
      `Set where pasted and dropped files are stored. ${PATH_START}`,
    );
    await flushConfigWrites(page, workerServer.contentDir);
    expect(readProjectConfig(workerServer.contentDir)).toMatch(savedAttachmentFolderPath('/'));
    await field.fill('/attachments');
    await field.press('Enter');
    await expect
      .poll(() => readProjectConfig(workerServer.contentDir), { timeout: 10_000 })
      .toMatch(savedAttachmentFolderPath('/attachments'));

    const RESERVED = 'Folder names cannot contain < > : " \\ | ? *.';
    for (const [typed, message] of [
      ['./a<b', RESERVED],
      ['./a>b', RESERVED],
      ['./a:b', RESERVED],
      ['./a"b', RESERVED],
      ['./a|b', RESERVED],
      ['./a?b', RESERVED],
      ['./a*b', RESERVED],
      ['./a\\b', RESERVED],
      ['../shared', PATH_START],
      ['./../media', PATH_START],
      ['./{/////', 'Use one slash between folder names.'],
      ['./{', 'A variable needs two braces on each side, such as {{filename}}.'],
      ['./media}', 'A variable needs two braces on each side, such as {{filename}}.'],
      ['./media/', 'Remove the slash at the end of the path.'],
      [' ./media', 'Remove the spaces at the start or end of the path.'],
      ['', PATH_START],
    ]) {
      await field.fill(typed);
      await expect(fieldError).toHaveText(message);
      await expect(fieldError).not.toHaveAttribute('role', 'alert');
      await expect(page.getByTestId('settings-attachments-preview')).toHaveCount(0);
      await field.blur();
      await expect(field).toHaveValue(typed);
      await expect(fieldError).toHaveText(message);
      await expect(fieldError).toHaveAttribute('role', 'alert');
    }
    await flushConfigWrites(page, workerServer.contentDir);
    expect(readProjectConfig(workerServer.contentDir)).toMatch(
      savedAttachmentFolderPath('/attachments'),
    );

    await field.fill('./media');
    await field.blur();
    await expect
      .poll(() => readProjectConfig(workerServer.contentDir), { timeout: 10_000 })
      .toMatch(savedAttachmentFolderPath('./media'));
  });

  test('a bare path saved by older versions shows with its leading slash, no error, and is not saved again on blur', async ({
    page,
    api,
    workerServer,
  }) => {
    await api.testReset();
    writeAttachmentFolderPath(workerServer.contentDir, 'attachments');
    await openSettingsSection(page, 'project-preferences', 'settings-attachments');

    const field = page.getByTestId('settings-attachments-path');
    await expect(field).toHaveValue('/attachments');
    await expect(page.getByTestId('settings-attachments-path-error')).toHaveCount(0);
    await expect(page.getByTestId('settings-attachments-preview')).toContainText(
      'attachments/image.png',
    );
    await field.focus();
    await field.blur();
    await flushConfigWrites(page, workerServer.contentDir);
    expect(readProjectConfig(workerServer.contentDir)).toMatch(
      savedAttachmentFolderPath('attachments'),
    );
  });

  test('a stored invalid path opens with its error and is not saved again on blur', async ({
    page,
    api,
    workerServer,
  }) => {
    for (const [stored, message] of [
      ['/<<<<<<', 'Folder names cannot contain < > : " \\ | ? *.'],
      ['./media/', 'Remove the slash at the end of the path.'],
      ['./assets{2024}', 'A variable needs two braces on each side, such as {{filename}}.'],
      ['./notes//media', 'Use one slash between folder names.'],
    ]) {
      await api.testReset();
      writeAttachmentFolderPath(workerServer.contentDir, stored);
      await openSettingsSection(page, 'project-preferences', 'settings-attachments');

      const field = page.getByTestId('settings-attachments-path');
      const fieldError = page.getByTestId('settings-attachments-path-error');
      await expect(field).toHaveValue(stored);
      await expect(field).toHaveAttribute('aria-invalid', 'true');
      await expect(fieldError).toHaveText(message);
      await expect(fieldError).not.toHaveAttribute('role', 'alert');
      await expect(page.getByTestId('settings-attachments-preview')).toHaveCount(0);
      await field.focus();
      await field.blur();
      await expect(fieldError).toHaveText(message);
      await expect(fieldError).not.toHaveAttribute('role', 'alert');

      await flushConfigWrites(page, workerServer.contentDir);
      expect(readProjectConfig(workerServer.contentDir)).toMatch(savedAttachmentFolderPath(stored));
    }
  });

  test('on a right-to-left page the path, its variables and the examples stay left to right', async ({
    page,
    api,
    workerServer,
  }) => {
    await api.testReset();
    writeAttachmentFolderPath(workerServer.contentDir, './{{filename}}.assets');
    await openSettingsSection(page, 'project-preferences', 'settings-attachments');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('ok-language-v1')))
      .not.toBeNull();
    await page.evaluate(() => {
      document.documentElement.dir = 'rtl';
    });

    const section = page.getByTestId('settings-attachments');
    const field = page.getByTestId('settings-attachments-path');
    const highlight = page.getByTestId('settings-attachments-path-highlight');
    await expect(field).toHaveValue('./{{filename}}.assets');
    const leadingText = await highlight.getByText('./', { exact: true }).boundingBox();
    const variable = await highlight.locator('[data-token="known"]').boundingBox();
    expect(leadingText?.x).toBeLessThan(variable?.x ?? 0);
    await expect(field).toHaveCSS('direction', 'ltr');
    expect(
      await section
        .locator('code')
        .evaluateAll((codes) => codes.map((code) => getComputedStyle(code).direction)),
    ).toEqual(['ltr', 'ltr']);

    await field.fill('./{{filename');
    await field.press('Enter');
    const tokens = page.getByTestId('settings-attachments-path-error').locator('bdi');
    await expect(tokens).toHaveText(['{{', '}}']);
    expect(
      await tokens.evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).direction)),
    ).toEqual(['ltr', 'ltr']);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });
});
