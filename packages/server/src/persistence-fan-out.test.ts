import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { swapContributors } from './contributor-tracker.ts';
import { applyExternalChange } from './external-change.ts';
import { claimExternalChange, clearExternalChangeClaims } from './external-change-attribution.ts';
import { createServer } from './server-factory.ts';
import { initShadowRepo, shadowGit } from './shadow-repo.ts';

describe('persistence L2 fan-out (US-014)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-fanout-test-'));
    swapContributors();
  });

  afterEach(() => {
    swapContributors();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a claimed external change commits on the actor ref, not file-system', async () => {
    clearExternalChangeClaims();
    const projectDir = tmpDir;
    const contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });
    const historyHandle = await initShadowRepo(projectDir);

    const server = createServer({
      contentDir,
      projectDir,
      contentRoot: 'content',
      quiet: true,
      debounce: 60_000,
      shadowRepo: historyHandle,
    });
    await server.ready;

    const conn = await server.hocuspocus.openDirectConnection('claimed-doc');
    await conn.transact((doc) => {
      doc.getText('source').insert(0, 'initial content\n');
    });

    const writerId = 'principal-33333333-3333-3333-3333-333333333333';
    claimExternalChange('claimed-doc', {
      writerId,
      displayName: 'Alice',
      colorSeed: writerId,
    });

    applyExternalChange(
      server.durabilityState,
      server.hocuspocus,
      'claimed-doc',
      '# Resolved by a person\n',
    );

    const doc = server.hocuspocus.documents.get('claimed-doc');
    doc?.removeDirectConnection();

    await server.destroy();

    const sg = shadowGit(historyHandle);
    const actorRef = (await sg.raw('rev-parse', `refs/wip/main/${writerId}`)).trim();
    expect(actorRef).toBeTruthy();

    const fsRefs = (
      await sg.raw('for-each-ref', '--format=%(refname)', 'refs/wip/main/file-system')
    ).trim();
    expect(fsRefs).toBe('');
  });
});
