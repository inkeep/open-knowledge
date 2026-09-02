import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { composeAndWriteRawBody } from './bridge-intake.ts';
import { DocumentDurabilityState } from './document-durability-state.ts';
import { getLogger } from './logger.ts';
import { createPersistenceExtension } from './persistence.ts';

const BROWSER_ORIGIN = {
  source: 'connection',
  connection: { context: { principalId: 'principal-test' } },
};

const FIXTURE_DIR = join(import.meta.dirname, 'persistence-tripwire.fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf-8');
}

async function storeDocument(
  persistence: ReturnType<typeof createPersistenceExtension>,
  document: Y.Doc,
  documentName: string,
): Promise<void> {
  await persistence.extension.onStoreDocument?.({
    document,
    documentName,
    lastTransactionOrigin: BROWSER_ORIGIN,
    lastContext: {},
  } as never);
}

describe('tripwire reset symlink-escape', () => {
  let contentDir: string;
  let durabilityState: DocumentDurabilityState;
  let outsideDir: string;
  let secretPath: string;
  const secretContent = '# SECRET\n\nThis content lives outside the content root.\n';

  beforeEach(() => {
    contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-tripwire-symlink-')));
    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-tripwire-outside-')));
    secretPath = join(outsideDir, 'secret.md');
    writeFileSync(secretPath, secretContent, 'utf-8');
    durabilityState = new DocumentDurabilityState();
  });

  afterEach(() => {
    rmSync(contentDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  test('refuses to load symlink target into Y.Doc; falls back to in-memory currentBase', async () => {
    const docName = 'incident-tripwire-symlink';
    const baseMarkdown = loadFixture('incident-changeset-readme-doubled.base.md');
    const doubledMarkdown = loadFixture('incident-changeset-readme-doubled.candidate.md');

    const docPath = join(contentDir, `${docName}.md`);
    symlinkSync(secretPath, docPath);

    const persistence = createPersistenceExtension({
      contentDir,
      projectDir: contentDir,
      gitEnabled: false,
      durabilityState,
    });

    const document = new Y.Doc();
    composeAndWriteRawBody(document, doubledMarkdown, 'agent');
    durabilityState.setReconciledBase(docName, baseMarkdown);

    const warnSpy = vi.spyOn(getLogger('persistence'), 'warn');
    try {
      await storeDocument(persistence, document, docName);

      const ytextAfter = document.getText('source').toString();
      expect(ytextAfter).not.toContain('SECRET');
      expect(ytextAfter).not.toContain('lives outside the content root');

      const escapeWarning = warnSpy.mock.calls
        .map((call) => String(call[1] ?? ''))
        .find((s) => s.includes('symlink-escape on tripwire reset'));
      expect(escapeWarning).toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }

    expect(readFileSync(secretPath, 'utf-8')).toBe(secretContent);
  });
});
