import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import * as Y from 'yjs';
import { _resetDocExtensionsForTests, isRegisteredMarkdownDocName } from './doc-extensions.ts';
import { createPersistenceExtension } from './persistence.ts';

let contentDir: string;

beforeEach(() => {
  _resetDocExtensionsForTests();
  contentDir = mkdtempSync(join(tmpdir(), 'ok-load-before-watcher-'));
});

afterEach(() => {
  _resetDocExtensionsForTests();
  rmSync(contentDir, { recursive: true, force: true });
});

test('a page opened before the watcher has seen its new .mdx file loads that file', async () => {
  const seed = '# Seed\n\n<Callout>Body.</Callout>\n';
  writeFileSync(join(contentDir, 'fresh.mdx'), seed);
  const persistence = createPersistenceExtension({
    mergeHistory: null,
    ingestDiskAtStore: null,
    contentDir,
  });
  const document = new Y.Doc();

  await persistence.extension.onLoadDocument?.({
    document,
    documentName: 'fresh',
    context: {},
  } as never);

  expect(document.getText('source').toString()).toBe(seed);
});

test('a page name with a parent segment registers no extension when it loads', async () => {
  writeFileSync(join(contentDir, 'fresh.mdx'), '# Seed\n');
  const persistence = createPersistenceExtension({
    mergeHistory: null,
    ingestDiskAtStore: null,
    contentDir,
  });

  await persistence.extension.onLoadDocument?.({
    document: new Y.Doc(),
    documentName: 'other/../fresh',
    context: {},
  } as never);

  expect(isRegisteredMarkdownDocName('other/../fresh')).toBe(false);
});
