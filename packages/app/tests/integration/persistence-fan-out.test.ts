/**
 * Per-writer L2 fan-out integration tests.
 *
 * Verifies that commitToWipRef fans out one commitWipFromTree call per
 * contributor in the snapshot, with all per-writer commits sharing the same
 * tree SHA. Also verifies file-system writer and concurrent writer scenarios.
 *
 * Mirrors packages/server/src/persistence-fan-out.test.ts but imports from
 * @inkeep/open-knowledge-server (the published package) so regressions in the
 * compiled artifact surface at integration tier (not just server unit tier).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyExternalChange,
  createServer,
  FILE_SYSTEM_WRITER,
  initShadowRepo,
  recordContributor,
  shadowGit,
  swapContributors,
} from '@inkeep/open-knowledge-server';
import * as Y from 'yjs';

describe('persistence L2 fan-out integration (US-014, FR-7)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-fanout-int-'));
    swapContributors();
  });

  afterEach(() => {
    swapContributors();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('two contributors → two WIP refs sharing the same tree SHA', async () => {
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

    // Seed two distinct writers before the L2 drain fires
    recordContributor('test-doc', 'agent-s1', 'Session 1', 'agent-s1');
    recordContributor('test-doc', 'agent-s2', 'Session 2', 'agent-s2');

    // Mutate the doc so onStoreDocument has content to flush
    const conn = await server.hocuspocus.openDirectConnection('test-doc');
    await conn.transact((doc) => {
      const xmlFragment = doc.getXmlFragment('default');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('fan-out integration test')]);
      xmlFragment.insert(0, [paragraph]);
    });

    const doc = server.hocuspocus.documents.get('test-doc');
    expect(doc).toBeDefined();
    doc?.removeDirectConnection();

    await server.destroy();

    // Both writers must have WIP refs
    const sg = shadowGit(historyHandle);
    const s1Sha = (await sg.raw('rev-parse', 'refs/wip/main/agent-s1')).trim();
    const s2Sha = (await sg.raw('rev-parse', 'refs/wip/main/agent-s2')).trim();
    expect(s1Sha).toBeTruthy();
    expect(s2Sha).toBeTruthy();

    // Different commits (different parents / timestamps)
    expect(s1Sha).not.toBe(s2Sha);

    // Both commits share the same tree SHA (one tree per drain cycle)
    const s1Tree = (await sg.raw('rev-parse', `${s1Sha}^{tree}`)).trim();
    const s2Tree = (await sg.raw('rev-parse', `${s2Sha}^{tree}`)).trim();
    expect(s1Tree).toBe(s2Tree);
  });

  test('SERVICE_WRITER fallback when snapshot is empty', async () => {
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

    // No contributors recorded — persistence uses SERVICE_WRITER fallback
    const conn = await server.hocuspocus.openDirectConnection('test-doc');
    await conn.transact((doc) => {
      const xmlFragment = doc.getXmlFragment('default');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('service-writer fallback test')]);
      xmlFragment.insert(0, [paragraph]);
    });

    const doc = server.hocuspocus.documents.get('test-doc');
    doc?.removeDirectConnection();

    await server.destroy();

    const sg = shadowGit(historyHandle);
    const wipRefs = (await sg.raw('for-each-ref', '--format=%(refname)', 'refs/wip/')).trim();
    expect(wipRefs).toBeTruthy();
  });

  test('applyExternalChange → commit on refs/wip/<branch>/file-system', async () => {
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

    // Load the doc via a direct connection + mutation
    const conn = await server.hocuspocus.openDirectConnection('fs-writer-doc');
    await conn.transact((doc) => {
      const xmlFragment = doc.getXmlFragment('default');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('initial content')]);
      xmlFragment.insert(0, [paragraph]);
    });

    // Simulate a file-watcher external change — registers file-system contributor
    applyExternalChange(server.hocuspocus, 'fs-writer-doc', '# Updated from disk\n');

    const doc = server.hocuspocus.documents.get('fs-writer-doc');
    doc?.removeDirectConnection();

    await server.destroy();

    const sg = shadowGit(historyHandle);
    const fsRef = (await sg.raw('rev-parse', 'refs/wip/main/file-system')).trim();
    expect(fsRef).toBeTruthy();

    // Commit subject must use reconcile: prefix
    const subject = (await sg.raw('log', '-1', '--format=%s', 'refs/wip/main/file-system')).trim();
    expect(subject).toBe('reconcile: fs-writer-doc');
  });

  test('concurrent agent + file-watcher → two commits sharing tree SHA', async () => {
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

    // Load the doc
    const conn = await server.hocuspocus.openDirectConnection('concurrent-doc');
    await conn.transact((doc) => {
      const xmlFragment = doc.getXmlFragment('default');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('concurrent test')]);
      xmlFragment.insert(0, [paragraph]);
    });

    // Agent contributor (simulating an agent write)
    recordContributor('concurrent-doc', 'agent-s1', 'Session 1', 'agent-s1');

    // File-watcher contributor (simulating an external disk change)
    applyExternalChange(server.hocuspocus, 'concurrent-doc', '# Updated concurrently\n');

    const doc = server.hocuspocus.documents.get('concurrent-doc');
    doc?.removeDirectConnection();

    await server.destroy();

    const sg = shadowGit(historyHandle);

    // Both refs must exist after the drain
    const agentSha = (await sg.raw('rev-parse', 'refs/wip/main/agent-s1')).trim();
    const fsSha = (await sg.raw('rev-parse', 'refs/wip/main/file-system')).trim();
    expect(agentSha).toBeTruthy();
    expect(fsSha).toBeTruthy();

    // Different commits (two writers) but same tree SHA (shared tree per drain)
    expect(agentSha).not.toBe(fsSha);
    const agentTree = (await sg.raw('rev-parse', `${agentSha}^{tree}`)).trim();
    const fsTree = (await sg.raw('rev-parse', `${fsSha}^{tree}`)).trim();
    expect(agentTree).toBe(fsTree);

    // FILE_SYSTEM_WRITER.id is 'file-system'
    expect(FILE_SYSTEM_WRITER.id).toBe('file-system');
  });
});
