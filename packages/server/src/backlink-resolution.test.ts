import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LOCAL_DIR, OK_DIR, skillLiveDocName } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import { BacklinkIndex } from './backlink-index.ts';

const roots: string[] = [];
function createIndex(): { index: BacklinkIndex; projectDir: string } {
  const projectDir = mkdtempSync(join(tmpdir(), 'ok-resolved-links-'));
  roots.push(projectDir);
  return { index: new BacklinkIndex({ projectDir, contentDir: projectDir }), projectDir };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resolved document relationships', () => {
  test('slug-collision targets stay stable when file inventory order changes', () => {
    for (const pages of [
      ['a/b', 'a-b'],
      ['a-b', 'a/b'],
    ]) {
      const { index } = createIndex();
      for (const name of pages) index.updateDocumentFromMarkdown(name, '# Target');
      index.updateDocumentFromMarkdown('source', '[[A B]]');
      expect(index.getForwardLinks('source')).toEqual(['a-b']);
      expect(index.getBacklinkCount('a-b')).toBe(1);
      expect(index.getBacklinkCount('a/b')).toBe(0);
    }
  });

  test('all graph views merge spelling variants and retain the representative source metadata', () => {
    const { index } = createIndex();
    index.updateDocumentFromMarkdown('notes/beta', '# Beta');
    index.updateDocumentFromMarkdown('source', 'See [[beta#intro]] and [[NOTES/BETA.md|Beta]].');
    index.updateDocumentFromMarkdown('second', 'See [[beta.mdx]].');
    expect(index.getBacklinks('notes/beta')).toEqual([
      { source: 'second', anchor: null, snippet: 'See beta.mdx.' },
      { source: 'source', anchor: 'intro', snippet: 'See beta#intro and Beta.' },
    ]);
    expect(index.getBacklinkCount('notes/beta')).toBe(2);
    expect(index.getBacklinks('beta')).toEqual([]);
    expect(index.getForwardLinks('source')).toEqual(['notes/beta']);
    expect(index.getForwardLinkEntries('source')).toEqual([
      { kind: 'doc', target: 'notes/beta', anchor: 'intro', snippet: 'See beta#intro and Beta.' },
    ]);
    expect(index.getOrphans(['notes/beta', 'source', 'second'], 'incoming')).toEqual([
      'second',
      'source',
    ]);
    expect(index.getOrphans(['notes/beta', 'source', 'second'], 'outgoing')).toEqual([
      'notes/beta',
    ]);
    expect(index.getHubs()).toEqual([{ docName: 'notes/beta', count: 2 }]);
    expect(index.getLinkGraph().links).toEqual([
      { source: 'source', target: 'notes/beta' },
      { source: 'second', target: 'notes/beta' },
    ]);
    expect(index.getLinkGraphNeighborhood('notes/beta', 1).nodes.map((node) => node.id)).toEqual([
      'notes/beta',
      'second',
      'source',
    ]);
  });

  test('literal Markdown and JSX targets remain literal while wiki assets stay out of the graph', () => {
    const { index } = createIndex();
    index.updateDocumentFromMarkdown('notes/beta', '# Beta');
    index.updateDocumentFromMarkdown('wiki', '[[beta]] [[logo.png]]');
    index.updateDocumentFromMarkdown('markdown', '[Beta](/beta.md)');
    index.updateDocumentFromMarkdown('jsx', '<Mirror src="beta" anchor="intro" />');
    expect(index.getForwardLinks('wiki')).toEqual(['notes/beta']);
    expect(index.getForwardLinks('markdown')).toEqual(['beta']);
    expect(index.getForwardLinks('jsx')).toEqual(['beta']);
    expect(index.getBacklinks('notes/beta').map((entry) => entry.source)).toEqual(['wiki']);
    expect(index.getBacklinks('beta').map((entry) => entry.source)).toEqual(['jsx', 'markdown']);
    expect(index.getLinkGraph().nodes.map((node) => node.id)).not.toContain('logo.png');
  });

  test('same-source wiki and literal keys keep separate identities before and after warm snapshot reconciliation', async () => {
    const { index, projectDir } = createIndex();
    mkdirSync(join(projectDir, 'notes'));
    writeFileSync(join(projectDir, 'notes/beta.md'), '# Beta');
    writeFileSync(join(projectDir, 'source.md'), '[[beta#intro]] and [literal](/beta.md#literal)');
    await index.rebuildFromDisk();
    const verify = (current: BacklinkIndex) => {
      expect(current.getForwardLinkEntries('source')).toEqual([
        expect.objectContaining({ kind: 'doc', target: 'beta', anchor: 'literal' }),
        expect.objectContaining({ kind: 'doc', target: 'notes/beta', anchor: 'intro' }),
      ]);
      expect(current.getBacklinkCount('notes/beta')).toBe(1);
      expect(current.getBacklinkCount('beta')).toBe(1);
      expect(current.getDeadLinks(['source', 'notes/beta'])).toEqual([
        {
          target: 'beta',
          sources: [expect.objectContaining({ source: 'source', sourceForm: 'markdown' })],
        },
      ]);
    };
    verify(index);
    await index.saveToDisk();
    const reloaded = new BacklinkIndex({ projectDir, contentDir: projectDir });
    expect(await reloaded.loadFromDisk()).toBe(true);
    const diff = await reloaded.reconcileWithDisk();
    expect(diff).toMatchObject({
      added: 0,
      updated: 0,
      deleted: 0,
      changedDocs: [],
    });
    expect(reloaded.getRenameSourceInventory().find((entry) => entry.docName === 'source')).toEqual(
      expect.objectContaining({ wikiTargets: ['beta'] }),
    );
    verify(reloaded);
    reloaded.updateDocumentFromMarkdown('source', '[literal](/beta.md#literal)');
    expect(reloaded.getForwardLinks('source')).toEqual(['beta']);
    expect(reloaded.getBacklinkCount('notes/beta')).toBe(0);
  });

  test('warm snapshot reconciliation preserves forward links, dead links and later fuzzy winners', async () => {
    const { index, projectDir } = createIndex();
    mkdirSync(join(projectDir, 'notes'));
    const docs = {
      'notes/beta': '# Beta',
      jsx: '<Mirror src="beta" anchor="intro" />',
      complete: '[Beta](/beta.md#intro)\n<Mirror src="beta" />',
      incomplete: '[](/beta.md)\n<Mirror src="beta" />',
      mixed: '[[beta#intro]] and [literal](/beta.md#literal)',
    };
    for (const [name, body] of Object.entries(docs))
      writeFileSync(join(projectDir, `${name}.md`), body);
    await index.rebuildFromDisk();
    const expected = Object.fromEntries(
      Object.keys(docs).map((name) => [name, index.getForwardLinkEntries(name)]),
    );
    const expectedDead = index.getDeadLinks(Object.keys(docs));
    await index.saveToDisk();
    const reloaded = new BacklinkIndex({ projectDir, contentDir: projectDir });
    expect(await reloaded.loadFromDisk()).toBe(true);
    expect(await reloaded.reconcileWithDisk()).toMatchObject({
      added: 0,
      updated: 0,
      deleted: 0,
      changedDocs: [],
    });
    for (const name of Object.keys(docs))
      expect(reloaded.getForwardLinkEntries(name)).toEqual(expected[name]);
    expect(reloaded.getDeadLinks(Object.keys(docs))).toEqual(expectedDead);
    expect(reloaded.getForwardLinkEntries('incomplete')).toEqual([
      expect.objectContaining({ target: 'beta', anchor: null, snippet: '<Mirror src="beta" />' }),
    ]);
    expect(reloaded.getForwardLinks('mixed')).toEqual(['beta', 'notes/beta']);
    reloaded.updateDocumentFromMarkdown('archive/beta', '# New fuzzy winner');
    expect(reloaded.getForwardLinks('mixed')).toEqual(['archive/beta', 'beta']);
    expect(reloaded.getForwardLinks('jsx')).toEqual(['beta']);
    expect(reloaded.getForwardLinks('complete')).toEqual(['beta']);
  });

  test('graph retains the lexically first incoming anchor under repeated fan-in', () => {
    const { index } = createIndex();
    index.updateDocumentFromMarkdown('target', '# Target');
    for (let i = 99; i >= 0; i--)
      index.updateDocumentFromMarkdown(
        `sources/${String(i).padStart(3, '0')}`,
        `[[target#anchor-${i}]]`,
      );
    const graph = index.getLinkGraph();
    expect(graph.nodes.filter((node) => node.id === 'target')).toEqual([
      { kind: 'doc', id: 'target', docName: 'target', anchor: 'anchor-0' },
    ]);
    expect(graph.links).toHaveLength(100);
    index.deleteDocument('sources/000');
    expect(index.getLinkGraph().nodes.find((node) => node.id === 'target')).toEqual({
      kind: 'doc',
      id: 'target',
      docName: 'target',
      anchor: 'anchor-1',
    });
  });

  test('snapshot v4 distinguishes wiki-only sources from colliding literal links', async () => {
    const snapshots: string[] = [];
    for (const [body, expectedTargets] of [
      ['[[beta]]', ['notes/beta']],
      ['[[beta]]\n[literal](/beta.md)', ['beta', 'notes/beta']],
    ] as const) {
      const { index, projectDir } = createIndex();
      index.updateDocumentFromMarkdown('notes/beta', '# Beta');
      index.updateDocumentFromMarkdown('source', body);
      expect(index.getForwardLinks('source')).toEqual(expectedTargets);
      await index.saveToDisk();
      snapshots.push(
        readFileSync(
          join(projectDir, OK_DIR, LOCAL_DIR, 'cache', 'main', 'backlinks.json'),
          'utf8',
        ),
      );
    }
    expect(snapshots[0]).not.toBe(snapshots[1]);
  });

  test('a body-only update replaces edges without an inventory change', () => {
    const { index } = createIndex();
    for (const doc of ['notes/beta', 'notes/gamma'])
      index.updateDocumentFromMarkdown(doc, '# Target');
    index.updateDocumentFromMarkdown('source', '[[beta]]');
    expect(index.getBacklinkCount('notes/beta')).toBe(1);
    index.updateDocumentFromMarkdown('source', '[[GAMMA.md#next]]');
    expect(index.getBacklinks('notes/beta')).toEqual([]);
    expect(index.getBacklinkCount('notes/gamma')).toBe(1);
    expect(index.getForwardLinkEntries('source')).toEqual([
      { kind: 'doc', target: 'notes/gamma', anchor: 'next', snippet: 'GAMMA.md#next' },
    ]);
    expect(index.getOrphans(['notes/beta', 'notes/gamma'], 'incoming')).toEqual(['notes/beta']);
    expect(index.getHubs()).toEqual([{ docName: 'notes/gamma', count: 1 }]);
    expect(index.getLinkGraph().links).toEqual([{ source: 'source', target: 'notes/gamma' }]);
    expect(index.getLinkGraphNeighborhood('notes/beta', 1).nodes.map((node) => node.id)).toEqual([
      'notes/beta',
    ]);
  });

  test('incrementally maintained relationships equal a fresh rebuild after create, delete and edit walks', () => {
    const docNames = [
      'x',
      'x.md',
      'x.md.md',
      'x-md',
      'notes/x',
      'notes/x.md',
      'hub/index',
      'hub/hub',
      'hub.md/index',
      'hub.md/hub.md',
      'a/b',
      'a-b',
      'z/beta',
      'a/beta',
      'beta',
      'beta.md',
      'q/beta.md',
      '!!!',
    ];
    const targets = [
      'x',
      'x.md',
      'X.MD',
      'x.md.md',
      'x.mdx',
      'notes/x.md',
      'hub',
      'hub.md',
      'a/b',
      'A B',
      'a b.md',
      'beta',
      'beta.md',
      'BETA.mdx',
      'q/beta',
      '!!!',
      'x-md',
    ];
    let seed = 0x2f6b;
    const next = (bound: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % bound;
    };
    const names = [...new Set([...docNames, ...targets])];
    for (let walk = 0; walk < 40; walk++) {
      const { index } = createIndex();
      const docs = new Map<string, string>();
      for (let step = 0; step < 30; step++) {
        const name = docNames[next(docNames.length)] as string;
        if (docs.has(name) && next(4) === 0) {
          docs.delete(name);
          index.deleteDocument(name);
        } else {
          const body = Array.from(
            { length: next(3) },
            () => `[[${targets[next(targets.length)]}]]`,
          ).join(' ');
          docs.set(name, body || '# Page');
          index.updateDocumentFromMarkdown(name, body || '# Page');
        }
        index.getLinkGraph();
        const { index: fresh } = createIndex();
        for (const [doc, body] of docs) fresh.updateDocumentFromMarkdown(doc, body);
        for (const target of names) {
          const at = `walk ${walk} step ${step} ${target}`;
          expect(index.getForwardLinks(target), at).toEqual(fresh.getForwardLinks(target));
          expect(index.getBacklinks(target), at).toEqual(fresh.getBacklinks(target));
        }
      }
    }
  });

  test('inventory changes invalidate fuzzy winners, independently for each branch', () => {
    const { index } = createIndex();
    index.updateDocumentFromMarkdown('z/beta', '# Beta');
    index.updateDocumentFromMarkdown('source', '[[beta]]');
    expect(index.getForwardLinks('source')).toEqual(['z/beta']);
    index.updateDocumentFromMarkdown('a/beta', '# Beta');
    expect(index.getForwardLinks('source')).toEqual(['a/beta']);
    index.switchBranch('feature');
    index.updateDocumentFromMarkdown('f/beta', '# Beta');
    index.updateDocumentFromMarkdown('source', '[[beta]]');
    expect(index.getForwardLinks('source')).toEqual(['f/beta']);
    index.switchBranch('main');
    index.deleteDocument('a/beta');
    expect(index.getForwardLinks('source')).toEqual(['z/beta']);
    expect(index.getForwardLinks('source', 'feature')).toEqual(['f/beta']);
  });

  test('global skills cannot steal fuzzy targets while explicit and structural skill links survive', () => {
    const { index } = createIndex();
    const global = skillLiveDocName('global', 'guide');
    const globalReference = `${global}/references/beta`;
    index.registerGlobalSkillBundleNode(global);
    index.registerGlobalSkillBundleNode(globalReference);
    index.updateDocumentFromMarkdown('z/beta', '# Beta');
    index.updateDocumentFromMarkdown('source', `[[beta]] [[${global}]]`);
    index.updateDocumentFromMarkdown('.agents/skills/project/SKILL', '# Project');
    index.updateDocumentFromMarkdown('.agents/skills/project/references/gamma', '# Gamma');
    index.updateDocumentFromMarkdown('project-ref', '[[gamma]]');
    expect(index.getForwardLinks('source')).toEqual(
      [global, 'z/beta'].sort((a, b) => a.localeCompare(b)),
    );
    expect(index.getBacklinkCount('z/beta')).toBe(1);
    expect(index.getForwardLinks(global)).toContain(globalReference);
    expect(index.getBacklinks(globalReference)).toContainEqual({
      source: global,
      anchor: null,
      snippet: null,
    });
    expect(index.getForwardLinks('project-ref')).toEqual([
      '.agents/skills/project/references/gamma',
    ]);
    expect(index.getForwardLinks('.agents/skills/project/SKILL')).toContain(
      '.agents/skills/project/references/gamma',
    );
  });

  test('versioned raw-key snapshots query and reconcile without changing their persisted keys', async () => {
    const { index, projectDir } = createIndex();
    const cache = join(projectDir, OK_DIR, LOCAL_DIR, 'cache/main/backlinks.json');
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(
      cache,
      JSON.stringify({
        version: 4,
        backward: {
          beta: [{ source: 'source', anchor: 'intro', snippet: 'See Beta', sourceForm: 'wiki' }],
        },
        forward: { source: ['beta'], 'notes/beta': [] },
        externalForward: {},
        sourceLinks: {
          source: [{ target: 'beta', anchor: 'intro', snippet: 'See Beta', sourceForm: 'wiki' }],
          'notes/beta': [],
        },
      }),
    );
    expect(await index.loadFromDisk()).toBe(true);
    expect(index.getBacklinkCount('notes/beta')).toBe(1);
    expect(index.getForwardLinks('source')).toEqual(['notes/beta']);
    await index.saveToDisk();
    const saved = JSON.parse(readFileSync(cache, 'utf8'));
    expect(saved.version).toBe(4);
    expect(saved.forward.source).toEqual(['beta']);
    expect(Object.keys(saved.backward)).toEqual(['beta']);
    mkdirSync(join(projectDir, 'notes'));
    writeFileSync(join(projectDir, 'notes/beta.md'), '# Beta');
    writeFileSync(join(projectDir, 'source.md'), '[[BETA.md#changed]]');
    await index.reconcileWithDisk();
    expect(index.getBacklinks('notes/beta')).toEqual([
      { source: 'source', anchor: 'changed', snippet: 'BETA.md#changed' },
    ]);
  });
});
