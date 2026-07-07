/**
 * Regression: tripwire reset must not follow symlinks outside the content
 * root.
 *
 * The duplicate-write tripwire (in `onStoreDocument`) blocks a candidate
 * write whose body is an integer concatenation of the bridge-normalized
 * base, then resets the live Y.Doc to "disk canonical" by reading
 * `<contentDir>/<docName>.md` and applying it as the next ground truth.
 *
 * If the file at that path is a symlink whose target lives outside
 * `contentDir`, an unguarded `readFileSync` would load that target's bytes
 * into the live CRDT — and from there into every connected client. This
 * test plants exactly that shape and asserts the reset falls back to the
 * in-memory `currentBase` instead of leaking the foreign bytes.
 *
 * Drives `extension.onStoreDocument` directly (no Hocuspocus, no file
 * watcher) so the file-watcher's lifecycle/delete handling can't
 * short-circuit the tripwire path before it runs.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
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
import * as Y from 'yjs';
import { composeAndWriteRawBody } from './bridge-intake.ts';
import {
  createPersistenceExtension,
  setReconciledBase,
  switchReconciledBaseScope,
} from './persistence.ts';

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
  let outsideDir: string;
  let secretPath: string;
  const secretContent = '# SECRET\n\nThis content lives outside the content root.\n';

  beforeEach(() => {
    contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-tripwire-symlink-')));
    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-tripwire-outside-')));
    secretPath = join(outsideDir, 'secret.md');
    writeFileSync(secretPath, secretContent, 'utf-8');
    switchReconciledBaseScope('main');
  });

  afterEach(() => {
    switchReconciledBaseScope('main');
    rmSync(contentDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  test('refuses to load symlink target into Y.Doc; falls back to in-memory currentBase', async () => {
    const docName = 'incident-tripwire-symlink';
    const baseMarkdown = loadFixture('incident-changeset-readme-doubled.base.md');
    const doubledMarkdown = loadFixture('incident-changeset-readme-doubled.candidate.md');

    // Plant the in-tree path as a symlink pointing outside contentDir.
    // (Dropped through the front door — we never call onLoadDocument, so its
    // own symlink-escape gate doesn't intercept; the tripwire reset is the
    // exclusive code path under test.)
    const docPath = join(contentDir, `${docName}.md`);
    symlinkSync(secretPath, docPath);

    const persistence = createPersistenceExtension({
      contentDir,
      projectDir: contentDir,
      gitEnabled: false,
    });

    // Hand-construct the Y.Doc state the tripwire path expects: XmlFragment
    // + Y.Text holding the doubled candidate, with `reconciledBase` set to
    // the (clean) base. classifyDuplication will then return 'block' and
    // route into the reset disk-read.
    const document = new Y.Doc();
    composeAndWriteRawBody(document, doubledMarkdown, 'agent');
    setReconciledBase(docName, baseMarkdown);

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await storeDocument(persistence, document, docName);

      // The reset must NOT have loaded the secret content into the live
      // Y.Doc. We assert the negative explicitly because that's the
      // confidentiality property at stake.
      const ytextAfter = document.getText('source').toString();
      expect(ytextAfter).not.toContain('SECRET');
      expect(ytextAfter).not.toContain('lives outside the content root');

      // A symlink-escape warning should have fired so operators can spot a
      // hostile-symlink-planting attempt in the logs.
      const escapeWarning = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .find((s) => s.includes('symlink-escape on tripwire reset'));
      expect(escapeWarning).toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }

    // Disk file (still the symlink) is unchanged — the tripwire blocked the
    // candidate write, which is the existing tripwire contract.
    expect(readFileSync(secretPath, 'utf-8')).toBe(secretContent);
  });
});
