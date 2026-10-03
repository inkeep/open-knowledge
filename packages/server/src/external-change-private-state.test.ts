import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hocuspocus } from '@hocuspocus/server';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type * as Y from 'yjs';
import { RECONCILE_TEST_CONFLICTS } from './conflict-authority.test-helper.ts';
import { DocumentDurabilityState } from './document-durability-state.ts';
import { reconcileDiskBeforeAgentWrite } from './external-change.ts';

describe('reconcile before an agent write', () => {
  let contentDir = '';

  beforeEach(() => {
    contentDir = realpathSync(mkdtempSync(join(tmpdir(), 'ok-reconcile-private-')));
    mkdirSync(join(contentDir, '.ok', 'local'), { recursive: true });
    writeFileSync(join(contentDir, '.ok', 'local', 'secret.md'), '# Secret\n\nprivate bytes\n');
  });

  afterEach(() => {
    rmSync(contentDir, { recursive: true, force: true });
  });

  test.runIf(process.platform !== 'win32')(
    'leaves a loaded document unchanged when its file becomes a link into private state',
    async () => {
      const hp = new Hocuspocus({ quiet: true });
      const durabilityState = new DocumentDurabilityState();
      const base = '# Notes\n\nFirst paragraph.\n';
      const conn = await hp.openDirectConnection('note');
      const doc = (conn as unknown as { document: Y.Doc }).document;
      writeFileSync(join(contentDir, 'note.md'), base);
      durabilityState.setReconciledBase('note', base);
      doc.transact(() => {
        doc.getText('source').insert(0, base);
      }, 'seed');

      unlinkSync(join(contentDir, 'note.md'));
      symlinkSync('.ok/local/secret.md', join(contentDir, 'note.md'));

      const result = reconcileDiskBeforeAgentWrite(
        durabilityState,
        hp,
        'note',
        contentDir,
        undefined,
        undefined,
        RECONCILE_TEST_CONFLICTS,
      );

      expect(result.reconciled).toBe(false);
      expect(doc.getText('source').toString()).toBe(base);
      await conn.disconnect();
    },
  );
});
