/**
 * Regression: tripwire reset must tolerate a transient `readFileSync` failure
 * without permanently latching the per-doc circuit breaker.
 *
 * The duplicate-write tripwire (in `onStoreDocument`) blocks a candidate
 * write whose body is an integer concatenation of the bridge-normalized
 * base. After blocking, it resets the live Y.Doc to "disk canonical" by
 * reading `<contentDir>/<docName>.md`. The realpath gate and
 * `isWithinContentDir` check protect against symlink-escape, but the
 * subsequent `readFileSync` itself was previously unguarded — a transient
 * EMFILE / EIO / EISDIR (etc.) propagated to the outer catch that adds the
 * doc to `tripwireResetFailedDocs`, disabling tripwire protection for the
 * doc until a lifecycle change clears it.
 *
 * This test plants a directory at the docname path so `readFileSync(canonical,
 * 'utf-8')` raises EISDIR, mirroring the failure shape. With the inner
 * try/catch in place, the tripwire falls back to in-memory `currentBase`,
 * applies it, and the breaker stays cleared. Without the guard, the breaker
 * would latch and the live Y.Doc would remain at the doubled state.
 *
 * Drives `extension.onStoreDocument` directly (no Hocuspocus, no file
 * watcher) so the file-watcher's lifecycle handling can't short-circuit the
 * tripwire path before it runs.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
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

describe('tripwire reset readFileSync failure', () => {
  let contentDir: string;

  beforeEach(() => {
    contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-tripwire-readfail-')));
    switchReconciledBaseScope('main');
  });

  afterEach(() => {
    switchReconciledBaseScope('main');
    rmSync(contentDir, { recursive: true, force: true });
  });

  test('falls back to currentBase when readFileSync throws (e.g. EISDIR); tripwire stays usable', async () => {
    const docName = 'incident-tripwire-readfail';
    const baseMarkdown = loadFixture('incident-changeset-readme-doubled.base.md');
    const doubledMarkdown = loadFixture('incident-changeset-readme-doubled.candidate.md');

    // Plant a directory at <contentDir>/<docName>.md so realpath returns the
    // path, isWithinContentDir returns true, but readFileSync raises EISDIR.
    mkdirSync(join(contentDir, `${docName}.md`));

    const persistence = createPersistenceExtension({
      contentDir,
      projectDir: contentDir,
      gitEnabled: false,
    });

    const document = new Y.Doc();
    composeAndWriteRawBody(document, doubledMarkdown, 'agent');
    setReconciledBase(docName, baseMarkdown);

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // First tripwire fire: the read throws but the inner try/catch
      // recovers to currentBase; the breaker is then cleared via the
      // success path's `tripwireResetFailedDocs.delete(documentName)`.
      await storeDocument(persistence, document, docName);

      // Live Y.Doc should now reflect `currentBase` (the bridge-normalized
      // base) rather than the original doubled content. This proves the
      // reset path applied the in-memory fallback rather than aborting.
      const ytextAfter = document.getText('source').toString();
      expect(ytextAfter).toBe(baseMarkdown);

      // Second tripwire fire on the same doc must still execute the reset
      // logic — i.e., the breaker did NOT latch. We reload the doubled
      // content first so the duplicate-classifier triggers `kind: 'block'`.
      composeAndWriteRawBody(document, doubledMarkdown, 'agent');
      // currentBase is still set (success path didn't clear it).
      await storeDocument(persistence, document, docName);

      // After the second fire, the doc should once again be reset to base.
      // If the breaker had latched after the first fire, the second fire
      // would log "Tripwire breaker active — skipping duplicate store" and
      // the doc would remain at the doubled state.
      expect(document.getText('source').toString()).toBe(baseMarkdown);
      const breakerActiveSkips = warnSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((s) => s.includes('Tripwire breaker active'));
      expect(breakerActiveSkips.length).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
