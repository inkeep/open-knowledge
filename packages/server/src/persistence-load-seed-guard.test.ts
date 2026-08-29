/**
 * `onLoadDocument`'s seed-from-disk guard must consult Y.Text, not only the
 * derived XmlFragment.
 *
 * Y.Text is the source of truth (precedent #38), so a document already holding
 * source bytes has content by definition — whether or not its fragment has been
 * derived. A fragment-only emptiness test asks the DERIVED replica a question
 * the truth surface owns: a doc whose Y.Text is populated but whose fragment
 * has not been built reads as empty, and the load seeds the file's bytes ON TOP
 * of the live ones. On the ordinary cold load the two surfaces are empty
 * together (the seed is a paired write that populates both), so requiring both
 * empty is strictly more conservative and changes nothing about that path —
 * which the `control:` row pins.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { DocumentDurabilityState } from './document-durability-state.ts';
import {
  createPersistenceExtension as createBase,
  type PersistenceOptions,
} from './persistence.ts';

let tmpDir: string;
let durabilityState: DocumentDurabilityState;

const create = (options: PersistenceOptions) => createBase({ ...options, durabilityState });

async function loadDocument(
  persistence: ReturnType<typeof create>,
  document: Y.Doc,
  documentName: string,
): Promise<void> {
  await persistence.extension.onLoadDocument?.({ document, documentName, context: {} } as never);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ok-load-seed-guard-'));
  durabilityState = new DocumentDurabilityState();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('onLoadDocument seed guard', () => {
  const docName = 'note.md';
  const DISK = '# from disk\n\nDisk paragraph.\n';

  function writeDisk(): void {
    const path = join(tmpDir, docName);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, DISK, 'utf-8');
  }

  test('control: a doc empty on BOTH surfaces still seeds from disk', async () => {
    writeDisk();
    const persistence = create({ contentDir: tmpDir, projectDir: tmpDir, gitEnabled: false });
    const document = new Y.Doc();

    await loadDocument(persistence, document, docName);

    expect(document.getText('source').toString()).toBe(DISK);
    expect(document.getXmlFragment('default').length).toBeGreaterThan(0);
  });

  test('a doc holding Y.Text bytes with an underived fragment is NOT re-seeded', async () => {
    writeDisk();
    const persistence = create({ contentDir: tmpDir, projectDir: tmpDir, gitEnabled: false });
    const document = new Y.Doc();
    const live = '# live\n\nTyped in source mode, fragment never derived.\n';
    document.getText('source').insert(0, live);
    expect(document.getXmlFragment('default').length).toBe(0);

    await loadDocument(persistence, document, docName);

    // The disk bytes must not be concatenated onto the live ones.
    expect(document.getText('source').toString()).toBe(live);
    expect(document.getText('source').toString()).not.toContain('Disk paragraph.');
  });
});
