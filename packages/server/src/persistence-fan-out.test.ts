
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { recordContributor, swapContributors } from './contributor-tracker.ts';
import { applyExternalChange } from './external-change.ts';
import { createServer } from './server-factory.ts';
import { FILE_SYSTEM_WRITER, initShadowRepo, shadowGit } from './shadow-repo.ts';

describe('persistence L2 fan-out (US-014)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-fanout-test-'));
    swapContributors();
  });

  afterEach(() => {
    swapContributors(); // drain to prevent leaking into next test
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

    recordContributor('test-doc', 'agent-s1', 'Session 1', 'agent-s1');
    recordContributor('test-doc', 'agent-s2', 'Session 2', 'agent-s2');

    const conn = await server.hocuspocus.openDirectConnection('test-doc');
    await conn.transact((doc) => {
      const xmlFragment = doc.getXmlFragment('default');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('fan-out test')]);
      xmlFragment.insert(0, [paragraph]);
    });

    const doc = server.hocuspocus.documents.get('test-doc');
    expect(doc).toBeDefined();
    doc?.removeDirectConnection();

    await server.destroy();

    const sg = shadowGit(historyHandle);
    const s1Sha = (await sg.raw('rev-parse', 'refs/wip/main/agent-s1')).trim();
    const s2Sha = (await sg.raw('rev-parse', 'refs/wip/main/agent-s2')).trim();
    expect(s1Sha).toBeTruthy();
    expect(s2Sha).toBeTruthy();

    expect(s1Sha).not.toBe(s2Sha);

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

    const conn = await server.hocuspocus.openDirectConnection('test-doc');
    await conn.transact((doc) => {
      const xmlFragment = doc.getXmlFragment('default');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('service-writer test')]);
      xmlFragment.insert(0, [paragraph]);
    });

    const doc = server.hocuspocus.documents.get('test-doc');
    doc?.removeDirectConnection();

    await server.destroy();

    const sg = shadowGit(historyHandle);
    const wipRefs = (await sg.raw('for-each-ref', '--format=%(refname)', 'refs/wip/')).trim();
    expect(wipRefs).toBeTruthy(); // at least one ref exists
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

    const conn = await server.hocuspocus.openDirectConnection('fs-writer-doc');
    await conn.transact((doc) => {
      const xmlFragment = doc.getXmlFragment('default');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('initial content')]);
      xmlFragment.insert(0, [paragraph]);
    });

    applyExternalChange(server.hocuspocus, 'fs-writer-doc', '# Updated from disk\n');

    const doc = server.hocuspocus.documents.get('fs-writer-doc');
    doc?.removeDirectConnection();

    await server.destroy();

    const sg = shadowGit(historyHandle);
    const fsRef = (await sg.raw('rev-parse', 'refs/wip/main/file-system')).trim();
    expect(fsRef).toBeTruthy();

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

    const conn = await server.hocuspocus.openDirectConnection('concurrent-doc');
    await conn.transact((doc) => {
      const xmlFragment = doc.getXmlFragment('default');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('concurrent test')]);
      xmlFragment.insert(0, [paragraph]);
    });

    recordContributor('concurrent-doc', 'agent-s1', 'Session 1', 'agent-s1');

    applyExternalChange(server.hocuspocus, 'concurrent-doc', '# Updated concurrently\n');

    const doc = server.hocuspocus.documents.get('concurrent-doc');
    doc?.removeDirectConnection();

    await server.destroy();

    const sg = shadowGit(historyHandle);

    const agentSha = (await sg.raw('rev-parse', 'refs/wip/main/agent-s1')).trim();
    const fsSha = (await sg.raw('rev-parse', 'refs/wip/main/file-system')).trim();
    expect(agentSha).toBeTruthy();
    expect(fsSha).toBeTruthy();

    expect(agentSha).not.toBe(fsSha);
    const agentTree = (await sg.raw('rev-parse', `${agentSha}^{tree}`)).trim();
    const fsTree = (await sg.raw('rev-parse', `${fsSha}^{tree}`)).trim();
    expect(agentTree).toBe(fsTree);

    expect(FILE_SYSTEM_WRITER.id).toBe('file-system');
  });
});
