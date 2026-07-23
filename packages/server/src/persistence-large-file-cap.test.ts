import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOCUMENT_OPEN_BYTE_LIMIT } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { createPersistenceExtension, DocumentOpenSizeLimitError } from './persistence.ts';

async function loadDocument(
  persistence: ReturnType<typeof createPersistenceExtension>,
  document: Y.Doc,
  documentName: string,
): Promise<void> {
  await persistence.extension.onLoadDocument?.({
    document,
    documentName,
    context: {},
  } as never);
}

describe('persistence large-file cap', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-large-file-cap-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('rejects oversized document load before seeding the Y.Doc', async () => {
    const filePath = join(tmpDir, 'big.md');
    writeFileSync(filePath, '');
    truncateSync(filePath, DOCUMENT_OPEN_BYTE_LIMIT + 1);
    const persistence = createPersistenceExtension({ contentDir: tmpDir });
    const document = new Y.Doc();

    await expect(loadDocument(persistence, document, 'big')).rejects.toBeInstanceOf(
      DocumentOpenSizeLimitError,
    );
    expect(document.getText('source').length).toBe(0);
    expect(document.getXmlFragment('default').length).toBe(0);
  });

  test('allows a document at exactly the byte limit', async () => {
    const filePath = join(tmpDir, 'exact.md');
    writeFileSync(filePath, 'a'.repeat(DOCUMENT_OPEN_BYTE_LIMIT));
    const persistence = createPersistenceExtension({ contentDir: tmpDir });
    const document = new Y.Doc();

    await expect(loadDocument(persistence, document, 'exact')).resolves.toBeUndefined();
    expect(document.getText('source').length).toBe(DOCUMENT_OPEN_BYTE_LIMIT);
  });
});
