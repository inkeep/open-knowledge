import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { LINEAGE_EPOCH_KEY } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import { FILE_WATCHER_ORIGIN } from './external-change.ts';
import { registerExternalSkill, unregisterExternalSkill } from './external-skill-registry.ts';
import * as fsTraced from './fs-traced.ts';
import {
  applyExternalManagedArtifactChange,
  loadManagedArtifactDoc,
  type ManagedArtifactCtx,
  managedArtifactAbsPath,
  managedArtifactContributorAttribution,
  managedArtifactDocNameForPath,
  managedArtifactSkillsRoots,
  managedArtifactTimelinePaths,
  storeManagedArtifactDoc,
} from './managed-artifact-persistence.ts';
import type { MergeHistoryRecorder } from './merge-history.ts';
import { getMetrics, resetMetrics } from './metrics.ts';
import type { KeptBlockPair } from './reconciliation.ts';

let projectDir: string;
let home: string;
let reconciled: Map<string, string>;

function makeCtx(history: ManagedArtifactCtx['history'] = null): ManagedArtifactCtx {
  return {
    projectDir,
    homedirOverride: home,
    lkgCache: new Map<string, string>(),
    setReconciledBase: (n, c) => reconciled.set(n, c),
    getReconciledBase: (n) => reconciled.get(n),
    history,
  };
}

interface RecordedHistory {
  bothKept: Array<{ docName: string; ours: string; theirs: string; kept: KeptBlockPair[] }>;
  keptLive: Array<{ docName: string; side: string; bytes: string; reason: string }>;
  backups: Array<{ docName: string; side: string; reason: string; display: string }>;
}

function recordingHistory(
  keptLiveSaves = true,
  duringKeptLive?: () => void,
): {
  history: Pick<MergeHistoryRecorder, 'bothKept' | 'keptLive' | 'noticeBackup'>;
  recorded: RecordedHistory;
} {
  const recorded: RecordedHistory = { bothKept: [], keptLive: [], backups: [] };
  return {
    recorded,
    history: {
      bothKept: (docName, versions, kept) => {
        recorded.bothKept.push({ docName, ...versions, kept: [...kept] });
      },
      keptLive: async (docName, displaced, reason) => {
        duringKeptLive?.();
        if (!keptLiveSaves) return false;
        recorded.keptLive.push({ docName, ...displaced, reason });
        return true;
      },
      noticeBackup: (docName, side, reason, backup) => {
        recorded.backups.push({ docName, side, reason, display: backup.display });
      },
    },
  };
}

function adoptClaudeHost(): void {
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'ok-ma-proj-'));
  home = mkdtempSync(join(tmpdir(), 'ok-ma-home-'));
  reconciled = new Map();
  resetMetrics();
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('managedArtifactAbsPath', () => {
  beforeEach(adoptClaudeHost);

  test('global with no native/store resolves to the IN-PLACE default home, never the store', () => {
    const ctx = makeCtx();
    expect(managedArtifactAbsPath('__skill__/project/my-skill', ctx)).toBe(
      resolve(projectDir, '.ok', 'skills', 'my-skill', 'SKILL.md'),
    );
    expect(managedArtifactAbsPath('__skill__/global/my-skill', ctx)).toBe(
      resolve(home, '.claude', 'skills', 'my-skill', 'SKILL.md'),
    );
  });

  test('global skill absent from the store resolves to its native editor dir (R12)', () => {
    const ctx = makeCtx();
    const nativeDir = resolve(home, '.claude', 'skills', 'native-one');
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(join(nativeDir, 'SKILL.md'), '---\nname: native-one\ndescription: d\n---\n# N');
    expect(managedArtifactAbsPath('__skill__/global/native-one', ctx)).toBe(
      resolve(nativeDir, 'SKILL.md'),
    );
    expect(managedArtifactAbsPath('__skill__/global/native-one/references/x', ctx)).toBe(
      resolve(nativeDir, 'references', 'x.md'),
    );
    const storeDir = resolve(home, '.ok', 'skills', 'native-one');
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, 'SKILL.md'), '---\nname: native-one\ndescription: d\n---\n# S');
    expect(managedArtifactAbsPath('__skill__/global/native-one', ctx)).toBe(
      resolve(nativeDir, 'SKILL.md'),
    );
    expect(managedArtifactAbsPath('__skill__/project/native-one', ctx)).toBe(
      resolve(projectDir, '.ok', 'skills', 'native-one', 'SKILL.md'),
    );
  });

  test('rejects path-escape + malformed names (security)', () => {
    const ctx = makeCtx();
    for (const bad of [
      '__skill__/project/..',
      '__skill__/project/../../etc/passwd',
      '__skill__/project/foo/../bar',
      '__skill__/global/foo/references/../../escape',
      '__skill__/project/Foo',
      '__skill__/project/foo.bar',
      '__skill__/project/',
      '__skill__/bogus/foo',
      'notes/foo',
    ]) {
      expect(() => managedArtifactAbsPath(bad, ctx)).toThrow();
    }
  });

  test('resolves a bundle FILE (rel) inside the resolved skill dir (per-file editability)', () => {
    const ctx = makeCtx();
    expect(managedArtifactAbsPath('__skill__/global/demo/references/patterns', ctx)).toBe(
      resolve(home, '.claude', 'skills', 'demo', 'references', 'patterns.md'),
    );
    const dir = resolve(home, '.claude', 'skills', 'demo', 'references');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'guide.mdx'), '# G\n', 'utf-8');
    expect(managedArtifactAbsPath('__skill__/global/demo/references/guide', ctx)).toBe(
      resolve(dir, 'guide.mdx'),
    );
  });

  test('store retirement: a legacy store resident with NO native is still read (drain-pending)', () => {
    const ctx = makeCtx();
    const storeDir = resolve(home, '.ok', 'skills', 'legacy-only');
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, 'SKILL.md'), '---\nname: legacy-only\ndescription: d\n---\n# L');
    expect(managedArtifactAbsPath('__skill__/global/legacy-only', ctx)).toBe(
      resolve(storeDir, 'SKILL.md'),
    );
  });

  test('rejects every __template__ name — templates never resolve through the managed disk path', () => {
    const ctx = makeCtx();
    for (const name of [
      '__template__/daily-note',
      '__template__/notes/sub/meeting',
      '__template__/',
      '__template__/../evil',
      '__template__/notes/bad name',
    ]) {
      expect(() => managedArtifactAbsPath(name, ctx)).toThrow();
    }
  });
});

describe('host-qualified global docs (same-name collision)', () => {
  beforeEach(adoptClaudeHost);

  function seedBundle(root: string, name: string, body: string): void {
    mkdirSync(join(home, root, name), { recursive: true });
    writeFileSync(join(home, root, name, 'SKILL.md'), body);
  }

  test('a qualified doc resolves inside ITS host root, never the by-name default', () => {
    const ctx = makeCtx();
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
    seedBundle('.claude/skills', 'dupe', 'claude copy');
    seedBundle('.agents/skills', 'dupe', 'agents copy');
    const unqualified = managedArtifactAbsPath('__skill__/global/dupe', ctx);
    const other = unqualified.includes(`${sep}.agents${sep}`) ? 'claude' : 'agents';
    const otherDir = other === 'claude' ? '.claude' : '.agents';
    const qualified = managedArtifactAbsPath(`__skill__/global/dupe@${other}`, ctx);
    expect(qualified).toBe(resolve(home, otherDir, 'skills', 'dupe', 'SKILL.md'));
    expect(qualified).not.toBe(unqualified);
    expect(managedArtifactAbsPath(`__skill__/global/dupe@${other}/references/x`, ctx)).toBe(
      resolve(home, otherDir, 'skills', 'dupe', 'references', 'x.md'),
    );
  });

  test('reverse mapping qualifies the non-default bundle and only it', () => {
    const ctx = makeCtx();
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
    seedBundle('.claude/skills', 'dupe', 'claude copy');
    seedBundle('.agents/skills', 'dupe', 'agents copy');
    const defaultDoc = managedArtifactDocNameForPath(
      resolve(home, '.claude/skills/dupe/SKILL.md'),
      ctx,
    );
    const otherDoc = managedArtifactDocNameForPath(
      resolve(home, '.agents/skills/dupe/SKILL.md'),
      ctx,
    );
    expect(new Set([defaultDoc, otherDoc]).size).toBe(2);
    expect([defaultDoc, otherDoc]).toContain('__skill__/global/dupe');
    expect(otherDoc === '__skill__/global/dupe' ? defaultDoc : otherDoc).toMatch(
      /^__skill__\/global\/dupe@[a-z-]+$/,
    );
    for (const d of [defaultDoc, otherDoc]) {
      expect(existsSync(managedArtifactAbsPath(d as string, ctx))).toBe(true);
    }
    expect(managedArtifactAbsPath(defaultDoc as string, ctx)).not.toBe(
      managedArtifactAbsPath(otherDoc as string, ctx),
    );
    seedBundle('.claude/skills', 'solo', 'only copy');
    expect(managedArtifactDocNameForPath(resolve(home, '.claude/skills/solo/SKILL.md'), ctx)).toBe(
      '__skill__/global/solo',
    );
  });
});

describe('store/load round-trip', () => {
  const SRC = '---\nname: demo\ndescription: a demo skill\n---\n\n# Demo\n\nBody line.\n';
  const docName = '__skill__/global/demo';

  beforeEach(() => {
    adoptClaudeHost();
    mkdirSync(dirname(managedArtifactAbsPath(docName, makeCtx())), { recursive: true });
  });

  test('store serializes Y.Text("source") verbatim to .ok/skills/<n>/SKILL.md', async () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, SRC), 'agent');
    const outcome = await storeManagedArtifactDoc(doc, docName, 'agent', ctx);
    expect(outcome).toBe('persisted');
    const path = managedArtifactAbsPath(docName, ctx);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe(SRC); // byte-identical (precedent #38)
  });

  test('verbatim fidelity: awkward-but-valid markdown survives byte-for-byte', async () => {
    const ctx = makeCtx();
    const awkward =
      '---\nname: demo\ndescription: d\n---\n## Heading\nNo blank line after heading\n\n*  weird   list spacing\n>quote no space\n';
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, awkward), 'agent');
    await storeManagedArtifactDoc(doc, docName, 'agent', ctx);
    expect(readFileSync(managedArtifactAbsPath(docName, ctx), 'utf-8')).toBe(awkward);
  });

  test('a store after an outside version was taken in writes nothing, and drops the write when that version is not on disk yet', async () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, SRC), 'agent');
    expect(await storeManagedArtifactDoc(doc, docName, FILE_WATCHER_ORIGIN, ctx)).toBe(
      'dropped-intake-landed',
    );
    expect(existsSync(managedArtifactAbsPath(docName, ctx))).toBe(false);

    ctx.lkgCache.set(docName, SRC);
    expect(await storeManagedArtifactDoc(doc, docName, FILE_WATCHER_ORIGIN, ctx)).toBe(
      'outside-taken-in',
    );
    expect(existsSync(managedArtifactAbsPath(docName, ctx))).toBe(false);
  });

  test('project-skill synthetic doc is INERT in load + store (double-doc guard)', async () => {
    const ctx = makeCtx();
    const projectDocName = '__skill__/project/demo';
    const projectPath = managedArtifactAbsPath(projectDocName, ctx);

    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, SRC), 'agent');
    expect(await storeManagedArtifactDoc(doc, projectDocName, 'agent', ctx)).toBe(
      'dropped-legacy-name',
    );
    expect(existsSync(projectPath)).toBe(false);

    mkdirSync(resolve(projectPath, '..'), { recursive: true });
    writeFileSync(projectPath, SRC, 'utf-8');
    const fresh = new Y.Doc();
    loadManagedArtifactDoc(fresh, projectDocName, ctx);
    expect(fresh.getText('source').toString()).toBe('');
    expect(fresh.getXmlFragment('default').length).toBe(0);
  });

  test('__template__ synthetic doc is INERT in load + store (tombstone, never creates a file)', async () => {
    const ctx = makeCtx();
    const templateDocName = '__template__/notes/daily';

    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, SRC), 'agent');
    expect(await storeManagedArtifactDoc(doc, templateDocName, 'agent', ctx)).toBe(
      'dropped-legacy-name',
    );

    const fresh = new Y.Doc();
    expect(() => loadManagedArtifactDoc(fresh, templateDocName, ctx)).not.toThrow();
    expect(fresh.getText('source').toString()).toBe('');
    expect(fresh.getXmlFragment('default').length).toBe(0);
    expect(fresh.getMap('lifecycle').get(LINEAGE_EPOCH_KEY)).toBeUndefined();

    expect(existsSync(join(projectDir, '__template__', 'notes', 'daily.md'))).toBe(false);
    expect(existsSync(join(projectDir, 'notes', '.ok', 'templates', 'daily.md'))).toBe(false);
  });

  test('store is a no-op when content equals LKG', async () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, SRC), 'agent');
    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('persisted');
    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('no-op');
  });

  test('load seeds Y.Text + XmlFragment from disk (paired-write)', () => {
    const ctx = makeCtx();
    const path = managedArtifactAbsPath(docName, ctx);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, SRC, 'utf-8');
    const doc = new Y.Doc();
    loadManagedArtifactDoc(doc, docName, ctx);
    expect(doc.getText('source').toString()).toBe(SRC);
    expect(doc.getXmlFragment('default').length).toBeGreaterThan(0);
    expect(reconciled.get(docName)).toBe(SRC);
  });

  test('load is lazy — a missing file seeds nothing (no auto-create)', () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    loadManagedArtifactDoc(doc, docName, ctx);
    expect(doc.getText('source').length).toBe(0);
    expect(existsSync(managedArtifactAbsPath(docName, ctx))).toBe(false);
  });

  test('load mints a fresh lineage epoch on each seed-from-disk', () => {
    const path = managedArtifactAbsPath(docName, makeCtx());
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, SRC, 'utf-8');

    const docA = new Y.Doc();
    loadManagedArtifactDoc(docA, docName, makeCtx());
    const epochA = docA.getMap('lifecycle').get(LINEAGE_EPOCH_KEY);
    expect(typeof epochA).toBe('string');
    expect((epochA as string).length).toBeGreaterThan(0);

    const docB = new Y.Doc();
    loadManagedArtifactDoc(docB, docName, makeCtx());
    expect(docB.getMap('lifecycle').get(LINEAGE_EPOCH_KEY)).not.toBe(epochA);
  });

  test('project-skill synthetic doc mints NO epoch (guard early-returns before the seed)', () => {
    const ctx = makeCtx();
    const projectDocName = '__skill__/project/demo';
    const projectPath = managedArtifactAbsPath(projectDocName, ctx);
    mkdirSync(resolve(projectPath, '..'), { recursive: true });
    writeFileSync(projectPath, SRC, 'utf-8');
    const doc = new Y.Doc();
    loadManagedArtifactDoc(doc, projectDocName, ctx);
    expect(doc.getMap('lifecycle').get(LINEAGE_EPOCH_KEY)).toBeUndefined();
  });
});

describe('discarded-edit backups', () => {
  beforeEach(adoptClaudeHost);

  async function reconcileLocalEdit(docName: string, outsideText: string): Promise<void> {
    const ctx = makeCtx();
    const path = managedArtifactAbsPath(docName, ctx);
    mkdirSync(dirname(path), { recursive: true });
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, 'base\n'), 'agent');
    await storeManagedArtifactDoc(doc, docName, 'agent', ctx);
    writeFileSync(path, `<<<<<<< here\n${outsideText}\n=======\nbase\n>>>>>>> there\n`, 'utf-8');
    doc.transact(
      () => doc.getText('source').insert(doc.getText('source').length, 'local'),
      'agent',
    );
    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('stash-fallback');
  }

  function backupDirs(): string[] {
    return readdirSync(resolve(home, '.ok', 'edit-backups', 'discarded')).sort();
  }

  function backupsIn(dir: string): string[] {
    const abs = resolve(home, '.ok', 'edit-backups', 'discarded', dir);
    return readdirSync(abs).map((f) => readFileSync(resolve(abs, f), 'utf-8'));
  }

  test('documents whose names differ only in non-Latin letters keep separate backups', async () => {
    await reconcileLocalEdit('__skill__/global/demo/references/会議', 'meeting edit');
    await reconcileLocalEdit('__skill__/global/demo/references/日報', 'daily edit');
    const dirs = backupDirs();
    expect(dirs).toHaveLength(2);
    const contents = dirs.map(backupsIn);
    expect(contents.map((c) => c.length)).toEqual([1, 1]);
    expect(contents.flat().some((c) => c.includes('meeting edit'))).toBe(true);
    expect(contents.flat().some((c) => c.includes('daily edit'))).toBe(true);
  });

  test('documents whose names differ only in punctuation keep separate backups', async () => {
    await reconcileLocalEdit('__skill__/global/demo/references/a b', 'space edit');
    await reconcileLocalEdit('__skill__/global/demo/references/a#b', 'hash edit');
    expect(backupDirs()).toHaveLength(2);
  });

  test('ASCII-safe documents keep the backup folder they had before', async () => {
    await reconcileLocalEdit('__skill__/global/demo/references/my_notes-v2.0', 'edit');
    expect(backupDirs()).toEqual(['__skill____global__demo__references__my_notes-v2.0']);
  });

  test('ASCII names that the separator encoding cannot tell apart keep separate backups', async () => {
    await reconcileLocalEdit('__skill__/global/demo/references/a/b', 'nested edit');
    await reconcileLocalEdit('__skill__/global/demo/references/a__b', 'underscore edit');
    await reconcileLocalEdit('__skill__/global/demo/references/a_/b', 'trailing edit');
    await reconcileLocalEdit('__skill__/global/demo/references/a/_b', 'leading edit');
    expect(backupDirs()).toHaveLength(4);
  });

  test('backup folder names stay filesystem-safe', async () => {
    await reconcileLocalEdit('__skill__/global/demo/references/会議 メモ', 'edit');
    for (const dir of backupDirs()) expect(dir).toMatch(/^[A-Za-z0-9._-]{1,120}$/);
  });
});

describe('an outside change to a global skill', () => {
  const docName = '__skill__/global/demo';
  const SAVED = '---\nname: demo\ndescription: a\n---\n\nFirst.\n\nSecond.\n';
  const HERE = '---\nname: demo\ndescription: a\n---\n\nFirst, here.\n\nSecond.\n';
  const OUTSIDE_SAME_BLOCK = '---\nname: demo\ndescription: a\n---\n\nFirst, outside.\n\nSecond.\n';
  const BOTH_KEPT =
    '---\nname: demo\ndescription: a\n---\n\nFirst, here.\n\nFirst, outside.\n\nSecond.\n';
  const OUTSIDE_OTHER_BLOCK =
    '---\nname: demo\ndescription: a\n---\n\nFirst.\n\nSecond, outside.\n';
  const MERGED = '---\nname: demo\ndescription: a\n---\n\nFirst, here.\n\nSecond, outside.\n';
  const OUTSIDE_WITH_MARKERS =
    '---\nname: demo\ndescription: a\n---\n\n<<<<<<< ours\nFirst, ours.\n=======\nFirst, theirs.\n>>>>>>> theirs\n\nSecond.\n';

  let path: string;

  beforeEach(() => {
    adoptClaudeHost();
    path = managedArtifactAbsPath(docName, makeCtx());
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, SAVED, 'utf-8');
  });

  function openSaved(ctx: ManagedArtifactCtx): Y.Doc {
    const doc = new Y.Doc();
    loadManagedArtifactDoc(doc, docName, ctx);
    return doc;
  }

  function editTo(doc: Y.Doc, text: string): void {
    doc.transact(() => {
      const src = doc.getText('source');
      src.delete(0, src.length);
      src.insert(0, text);
    }, 'agent');
  }

  function stashedFiles(): string[] {
    const root = resolve(home, '.ok', 'edit-backups', 'discarded');
    if (!existsSync(root)) return [];
    return readdirSync(root).flatMap((dir) =>
      readdirSync(resolve(root, dir)).map((f) => readFileSync(resolve(root, dir, f), 'utf-8')),
    );
  }

  test('a same-block collision at the store keeps both versions live and on disk, with both pre-merge versions recorded', async () => {
    const { history, recorded } = recordingHistory();
    const ctx = makeCtx(history);
    const doc = openSaved(ctx);
    editTo(doc, HERE);
    writeFileSync(path, OUTSIDE_SAME_BLOCK, 'utf-8');

    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('both-kept');

    expect(doc.getText('source').toString()).toBe(BOTH_KEPT);
    expect(readFileSync(path, 'utf-8')).toBe(BOTH_KEPT);
    expect(reconciled.get(docName)).toBe(BOTH_KEPT);
    expect(recorded.bothKept).toHaveLength(1);
    expect(recorded.bothKept[0]).toMatchObject({ docName, ours: HERE, theirs: OUTSIDE_SAME_BLOCK });
    expect(stashedFiles()).toEqual([]);
    expect(getMetrics().managedArtifactMerge).toEqual({ 'store:both-kept': 1 });
  });

  test('edits to different blocks merge at the store with no history entry', async () => {
    const { history, recorded } = recordingHistory();
    const ctx = makeCtx(history);
    const doc = openSaved(ctx);
    editTo(doc, HERE);
    writeFileSync(path, OUTSIDE_OTHER_BLOCK, 'utf-8');

    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('merged');

    expect(doc.getText('source').toString()).toBe(MERGED);
    expect(readFileSync(path, 'utf-8')).toBe(MERGED);
    expect(recorded).toEqual({ bothKept: [], keptLive: [], backups: [] });
  });

  test('an outside version that cannot be merged leaves the version here live and on disk and goes to history', async () => {
    const { history, recorded } = recordingHistory();
    const ctx = makeCtx(history);
    const doc = openSaved(ctx);
    editTo(doc, HERE);
    writeFileSync(path, OUTSIDE_WITH_MARKERS, 'utf-8');

    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('kept-live');

    expect(doc.getText('source').toString()).toBe(HERE);
    expect(readFileSync(path, 'utf-8')).toBe(HERE);
    expect(recorded.keptLive).toEqual([
      { docName, side: 'theirs', bytes: OUTSIDE_WITH_MARKERS, reason: 'conflict-markers' },
    ]);
    expect(stashedFiles()).toEqual([]);
  });

  test('a file that appears under a skill typed into before it existed keeps the version here', async () => {
    rmSync(path);
    const { history, recorded } = recordingHistory();
    const ctx = makeCtx(history);
    const doc = openSaved(ctx);
    editTo(doc, HERE);
    writeFileSync(path, OUTSIDE_SAME_BLOCK, 'utf-8');

    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('kept-live');

    expect(doc.getText('source').toString()).toBe(HERE);
    expect(readFileSync(path, 'utf-8')).toBe(HERE);
    expect(recorded.keptLive).toEqual([
      { docName, side: 'theirs', bytes: OUTSIDE_SAME_BLOCK, reason: 'no-base' },
    ]);
  });

  test('when history cannot hold the outside version it goes to the discarded-edit backups, with a notice naming the file', async () => {
    const { history, recorded } = recordingHistory(false);
    const ctx = makeCtx(history);
    const doc = openSaved(ctx);
    editTo(doc, HERE);
    writeFileSync(path, OUTSIDE_WITH_MARKERS, 'utf-8');

    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('stash-fallback');

    expect(readFileSync(path, 'utf-8')).toBe(HERE);
    expect(stashedFiles()).toEqual([OUTSIDE_WITH_MARKERS]);
    expect(recorded.backups).toEqual([
      {
        docName,
        side: 'theirs',
        reason: 'conflict-markers',
        display: expect.stringMatching(
          /^~\/\.ok\/edit-backups\/discarded\/__skill____global__demo\/.+\.md$/,
        ),
      },
    ]);
  });

  test('when neither history nor the stash can take the outside version, nothing is written', async () => {
    mkdirSync(join(home, '.ok'), { recursive: true });
    writeFileSync(join(home, '.ok', 'edit-backups'), 'not a folder');
    const { history } = recordingHistory(false);
    const ctx = makeCtx(history);
    const doc = openSaved(ctx);
    editTo(doc, HERE);
    writeFileSync(path, OUTSIDE_WITH_MARKERS, 'utf-8');

    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toEqual({
      kind: 'held',
      cause: 'no-history-or-backup',
    });

    expect(readFileSync(path, 'utf-8')).toBe(OUTSIDE_WITH_MARKERS);
    expect(doc.getText('source').toString()).toBe(HERE);
    expect(getMetrics().managedArtifactMerge).toEqual({ 'store:held': 1 });
  });

  test('an outside write during the history save of a refused merge is taken in before anything is written', async () => {
    const later = OUTSIDE_OTHER_BLOCK;
    let planted = false;
    const { history, recorded } = recordingHistory(true, () => {
      if (planted) return;
      planted = true;
      writeFileSync(path, later, 'utf-8');
    });
    const ctx = makeCtx(history);
    const doc = openSaved(ctx);
    editTo(doc, HERE);
    writeFileSync(path, OUTSIDE_WITH_MARKERS, 'utf-8');

    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('merged');

    expect(readFileSync(path, 'utf-8')).toBe(MERGED);
    expect(doc.getText('source').toString()).toBe(MERGED);
    expect(recorded.keptLive.map((entry) => entry.bytes)).toEqual([OUTSIDE_WITH_MARKERS]);
  });

  test('an outside write between the compare and the rename is refused and merged on the next round', async () => {
    const { history } = recordingHistory();
    const ctx = makeCtx(history);
    const doc = openSaved(ctx);
    editTo(doc, HERE);
    const write = fsTraced.tracedAtomicFs.writeFile;
    let planted = false;
    vi.spyOn(fsTraced.tracedAtomicFs, 'writeFile').mockImplementation(async (...args) => {
      await write(...args);
      if (planted) return;
      planted = true;
      writeFileSync(path, OUTSIDE_OTHER_BLOCK, 'utf-8');
    });

    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('merged');

    expect(readFileSync(path, 'utf-8')).toBe(MERGED);
    expect(getMetrics().storeRestatRefused).toBe(1);
  });

  test('an outside write between the compare and the rename of a both-kept merge leaves the live doc alone, and the retry records both pre-merge versions', async () => {
    const OUTSIDE_AGAIN =
      '---\nname: demo\ndescription: a\n---\n\nFirst, outside again.\n\nSecond.\n';
    const BOTH_KEPT_AGAIN =
      '---\nname: demo\ndescription: a\n---\n\nFirst, here.\n\nFirst, outside again.\n\nSecond.\n';
    const { history, recorded } = recordingHistory();
    const ctx = makeCtx(history);
    const doc = openSaved(ctx);
    editTo(doc, HERE);
    writeFileSync(path, OUTSIDE_SAME_BLOCK, 'utf-8');
    const write = fsTraced.tracedAtomicFs.writeFile;
    let liveAtPlant: string | undefined;
    vi.spyOn(fsTraced.tracedAtomicFs, 'writeFile').mockImplementation(async (...args) => {
      await write(...args);
      if (liveAtPlant !== undefined) return;
      liveAtPlant = doc.getText('source').toString();
      writeFileSync(path, OUTSIDE_AGAIN, 'utf-8');
    });

    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('both-kept');

    expect(liveAtPlant).toBe(HERE);
    expect(doc.getText('source').toString()).toBe(BOTH_KEPT_AGAIN);
    expect(readFileSync(path, 'utf-8')).toBe(BOTH_KEPT_AGAIN);
    expect(doc.getText('source').toString().split('First, here.')).toHaveLength(2);
    expect(recorded.bothKept).toHaveLength(1);
    expect(recorded.bothKept[0]).toMatchObject({ docName, ours: HERE, theirs: OUTSIDE_AGAIN });
    expect(getMetrics().storeRestatRefused).toBe(1);
  });

  test('an outside version that is not valid UTF-8 is neither merged nor written over, at the save or the intake', async () => {
    const { history, recorded } = recordingHistory();
    const ctx = makeCtx(history);
    const doc = openSaved(ctx);
    editTo(doc, HERE);
    const latin1 = Buffer.from(OUTSIDE_SAME_BLOCK.replace('outside', 'caf\u00e9'), 'latin1');
    writeFileSync(path, latin1);

    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toMatchObject({
      kind: 'held',
      cause: 'not-utf8',
      path,
    });
    expect(
      await applyExternalManagedArtifactChange(doc, docName, latin1.toString('utf8'), ctx),
    ).toBe('held');

    expect(readFileSync(path).equals(latin1)).toBe(true);
    expect(doc.getText('source').toString()).toBe(HERE);
    expect(recorded).toEqual({ bothKept: [], keptLive: [], backups: [] });
    expect(stashedFiles()).toEqual([]);
    expect(getMetrics().managedArtifactMerge).toEqual({ 'store:held': 1, 'intake:held': 1 });
  });

  test('the polled intake reports a lock timeout as held, and lets any other failure reach the watcher', async () => {
    const ctx = makeCtx(recordingHistory().history);
    const doc = openSaved(ctx);
    editTo(doc, HERE);
    writeFileSync(path, OUTSIDE_SAME_BLOCK, 'utf-8');
    const lock = `${path}.lock`;
    writeFileSync(lock, '');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
    try {
      const intake = applyExternalManagedArtifactChange(doc, docName, OUTSIDE_SAME_BLOCK, ctx);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await intake).toBe('held');
    } finally {
      vi.useRealTimers();
      rmSync(lock, { force: true });
    }
    expect(doc.getText('source').toString()).toBe(HERE);
    expect(getMetrics().managedArtifactMerge).toEqual({ 'intake:held': 1 });

    const failure = new Error('merge defect');
    const failing: ManagedArtifactCtx = {
      ...ctx,
      beforeReconcileDivergence: () => {
        throw failure;
      },
    };
    await expect(
      applyExternalManagedArtifactChange(doc, docName, OUTSIDE_SAME_BLOCK, failing),
    ).rejects.toBe(failure);
    expect(readFileSync(path, 'utf-8')).toBe(OUTSIDE_SAME_BLOCK);
  });

  test('a merge the polled intake writes while a save waits for the lock is not written over', async () => {
    const { history } = recordingHistory();
    const ctx = makeCtx(history);
    const doc = openSaved(ctx);
    editTo(doc, HERE);
    writeFileSync(path, OUTSIDE_SAME_BLOCK, 'utf-8');
    const mkdir = fsTraced.tracedMkdir;
    let intake: Promise<unknown> | undefined;
    vi.spyOn(fsTraced, 'tracedMkdir').mockImplementation(async (...args) => {
      if (intake === undefined) {
        intake = applyExternalManagedArtifactChange(doc, docName, OUTSIDE_SAME_BLOCK, ctx);
        await intake;
      }
      return mkdir(...args);
    });

    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('no-op');

    expect(await intake).toBe('both-kept');
    expect(readFileSync(path, 'utf-8')).toBe(BOTH_KEPT);
    expect(doc.getText('source').toString()).toBe(BOTH_KEPT);
  });

  test.skipIf(process.getuid?.() === 0)(
    'writes nothing when the file cannot be read for the compare',
    async () => {
      const ctx = makeCtx(recordingHistory().history);
      const doc = openSaved(ctx);
      editTo(doc, HERE);
      chmodSync(path, 0o000);
      try {
        expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toEqual({
          kind: 'held',
          cause: 'unreadable',
        });
      } finally {
        chmodSync(path, 0o644);
      }
      expect(readFileSync(path, 'utf-8')).toBe(SAVED);
    },
  );

  test('the paired apply hands the loss detector the version here and the text it applies', async () => {
    const calls: Array<{ docName: string; live: string; applied: string }> = [];
    const ctx: ManagedArtifactCtx = {
      ...makeCtx(recordingHistory().history),
      beforeReconcileDivergence: (_doc, name, live, applied) => {
        calls.push({ docName: name, live, applied });
        return undefined;
      },
    };
    const doc = openSaved(ctx);
    editTo(doc, HERE);
    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('persisted');
    expect(calls).toHaveLength(0);

    editTo(doc, `${HERE}\nThird, here.\n`);
    writeFileSync(path, OUTSIDE_OTHER_BLOCK.replace('First.', 'First, here.'), 'utf-8');
    const live = doc.getText('source').toString();
    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('merged');

    expect(calls).toEqual([{ docName, live, applied: doc.getText('source').toString() }]);
  });

  test('the store still merges when no checkpoint hook is wired', async () => {
    const ctx = makeCtx(recordingHistory().history);
    expect(ctx.beforeReconcileDivergence).toBeUndefined();
    const doc = openSaved(ctx);
    editTo(doc, HERE);
    writeFileSync(path, OUTSIDE_SAME_BLOCK, 'utf-8');
    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('both-kept');
  });

  test('the polled intake applies a refresh of a skill nobody edited, with no history', async () => {
    const { history, recorded } = recordingHistory();
    const ctx = makeCtx(history);
    const doc = openSaved(ctx);
    writeFileSync(path, OUTSIDE_OTHER_BLOCK, 'utf-8');

    expect(await applyExternalManagedArtifactChange(doc, docName, OUTSIDE_OTHER_BLOCK, ctx)).toBe(
      'applied',
    );

    expect(doc.getText('source').toString()).toBe(OUTSIDE_OTHER_BLOCK);
    expect(reconciled.get(docName)).toBe(OUTSIDE_OTHER_BLOCK);
    expect(recorded).toEqual({ bothKept: [], keptLive: [], backups: [] });
  });

  test('the polled intake keeps both versions of a block edited on both sides and writes the result', async () => {
    const { history, recorded } = recordingHistory();
    const ctx = makeCtx(history);
    const doc = openSaved(ctx);
    editTo(doc, HERE);
    writeFileSync(path, OUTSIDE_SAME_BLOCK, 'utf-8');

    expect(await applyExternalManagedArtifactChange(doc, docName, OUTSIDE_SAME_BLOCK, ctx)).toBe(
      'both-kept',
    );

    expect(doc.getText('source').toString()).toBe(BOTH_KEPT);
    expect(readFileSync(path, 'utf-8')).toBe(BOTH_KEPT);
    expect(recorded.bothKept).toHaveLength(1);
    expect(getMetrics().managedArtifactMerge).toEqual({ 'intake:both-kept': 1 });
  });

  test('the polled intake takes nothing in when the file moved on since the poll', async () => {
    const ctx = makeCtx(recordingHistory().history);
    const doc = openSaved(ctx);
    editTo(doc, HERE);
    writeFileSync(path, OUTSIDE_OTHER_BLOCK, 'utf-8');

    expect(await applyExternalManagedArtifactChange(doc, docName, OUTSIDE_SAME_BLOCK, ctx)).toBe(
      'no-op',
    );
    expect(doc.getText('source').toString()).toBe(HERE);
  });

  test('applyExternalManagedArtifactChange is a no-op for a null doc', async () => {
    const ctx = makeCtx();
    expect(await applyExternalManagedArtifactChange(null, docName, 'whatever', ctx)).toBe('no-op');
    expect(reconciled.has(docName)).toBe(false);
  });

  test('applyExternalManagedArtifactChange short-circuits a self-write (content === LKG)', async () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    const raw = '---\nname: demo\ndescription: a\n---\nBODY\n';
    ctx.lkgCache.set(docName, raw);
    expect(await applyExternalManagedArtifactChange(doc, docName, raw, ctx)).toBe('no-op');
    expect(doc.getText('source').toString()).toBe('');
    expect(reconciled.has(docName)).toBe(false);
  });
});

describe('an outside change to an external skill', () => {
  let skillDir: string;

  beforeEach(() => {
    skillDir = mkdtempSync(join(tmpdir(), 'ok-ma-ext-'));
    writeFileSync(join(skillDir, 'SKILL.md'), '# External\n\nFirst.\n\nSecond.\n', 'utf-8');
    registerExternalSkill('ext-merge', skillDir);
  });
  afterEach(() => {
    unregisterExternalSkill('ext-merge');
    rmSync(skillDir, { recursive: true, force: true });
  });

  test('a same-block collision at the store keeps both versions', async () => {
    const docName = '__extskill__/ext-merge';
    const { history, recorded } = recordingHistory();
    const ctx = makeCtx(history);
    const doc = new Y.Doc();
    loadManagedArtifactDoc(doc, docName, ctx);
    doc.transact(() => {
      const src = doc.getText('source');
      src.delete(0, src.length);
      src.insert(0, '# External\n\nFirst, here.\n\nSecond.\n');
    }, 'agent');
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '# External\n\nFirst, outside.\n\nSecond.\n',
      'utf-8',
    );

    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('both-kept');
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toBe(
      '# External\n\nFirst, here.\n\nFirst, outside.\n\nSecond.\n',
    );
    expect(recorded.bothKept).toHaveLength(1);
  });
});

describe('managedArtifactDocNameForPath (reverse resolver)', () => {
  beforeEach(adoptClaudeHost);

  test('maps a global SKILL.md leaf back to its doc name; project paths are content', () => {
    const ctx = makeCtx();
    expect(
      managedArtifactDocNameForPath(resolve(projectDir, '.ok/skills/my-skill/SKILL.md'), ctx),
    ).toBeNull();
    expect(
      managedArtifactDocNameForPath(resolve(home, '.ok/skills/notes-helper/SKILL.md'), ctx),
    ).toBe('__skill__/global/notes-helper');
    expect(
      managedArtifactDocNameForPath(resolve(home, '.ok/skills/nh/references/patterns.md'), ctx),
    ).toBe('__skill__/global/nh/references/patterns');
    expect(
      managedArtifactDocNameForPath(resolve(home, '.ok/skills/nh/references/guide.mdx'), ctx),
    ).toBe('__skill__/global/nh/references/guide');
    expect(
      managedArtifactDocNameForPath(resolve(home, '.ok/skills/nh/scripts/run.sh'), ctx),
    ).toBeNull();
  });

  test('maps NATIVE-root global skill leaves (in-place skills), same doc names as the store', () => {
    const ctx = makeCtx();
    expect(
      managedArtifactDocNameForPath(resolve(home, '.agents/skills/notes-helper/SKILL.md'), ctx),
    ).toBe('__skill__/global/notes-helper');
    expect(
      managedArtifactDocNameForPath(resolve(home, '.claude/skills/nh/references/patterns.md'), ctx),
    ).toBe('__skill__/global/nh/references/patterns');
    expect(
      managedArtifactDocNameForPath(resolve(home, '.agents/skills/nh/scripts/run.sh'), ctx),
    ).toBeNull();
  });

  test('round-trips with managedArtifactAbsPath (global skills)', () => {
    const ctx = makeCtx();
    for (const name of ['__skill__/global/beta-2', '__skill__/global/beta-2/references/patterns']) {
      expect(managedArtifactDocNameForPath(managedArtifactAbsPath(name, ctx), ctx)).toBe(name);
    }
  });

  test('template disk paths never reverse-map to a managed doc name (content docs now)', () => {
    const ctx = makeCtx();
    for (const path of [
      resolve(projectDir, '.ok/templates/daily.md'),
      resolve(projectDir, 'notes/sub/.ok/templates/meeting.md'),
      resolve(projectDir, '.ok/templates/a/b.md'),
    ]) {
      expect(managedArtifactDocNameForPath(path, ctx)).toBeNull();
    }
  });

  test('returns null for non-leaf / malformed / out-of-root paths', () => {
    const ctx = makeCtx();
    for (const bad of [
      resolve(projectDir, '.ok/skills/SKILL.md'),
      resolve(projectDir, '.ok/skills/a/b/SKILL.md'),
      resolve(projectDir, '.ok/skills/my-skill/OTHER.md'),
      resolve(projectDir, '.ok/skills/Bad/SKILL.md'),
      resolve(projectDir, '.ok/templates/t/SKILL.md'),
      resolve(projectDir, 'notes/SKILL.md'),
      '/etc/passwd',
    ]) {
      expect(managedArtifactDocNameForPath(bad, ctx)).toBeNull();
    }
  });
});

describe('managedArtifactContributorAttribution (editor-edit versioning)', () => {
  test('project skill → .ok/skills key + skill- subject', () => {
    expect(managedArtifactContributorAttribution('__skill__/project/trip-log')).toEqual({
      docKey: '.ok/skills/trip-log',
      subject: 'skill-edit: trip-log/SKILL.md',
    });
  });

  test('global skill → null (unversioned — outside any project shadow)', () => {
    expect(managedArtifactContributorAttribution('__skill__/global/notes')).toBeNull();
  });

  test('template name → null (content doc — attributed on its own path by the content store)', () => {
    expect(managedArtifactContributorAttribution('__template__/daily')).toBeNull();
    expect(managedArtifactContributorAttribution('__template__/notes/sub/meeting')).toBeNull();
  });

  test('non-managed-artifact name → null', () => {
    expect(managedArtifactContributorAttribution('notes/foo')).toBeNull();
  });
});

describe('managedArtifactSkillsRoots', () => {
  test('covers every native user root, with the legacy store included but not privileged', () => {
    for (const d of ['.claude', '.agents', '.ok']) mkdirSync(join(home, d), { recursive: true });
    const ctx = makeCtx();
    const roots = managedArtifactSkillsRoots(ctx);
    expect(roots).toContain(resolve(home, '.claude', 'skills'));
    expect(roots).toContain(resolve(home, '.agents', 'skills'));
    expect(roots).toContain(resolve(home, '.ok', 'skills'));
    expect(roots[0]).not.toBe(resolve(home, '.ok', 'skills'));
    expect(roots.every((r) => r.startsWith(home))).toBe(true);
  });

  test('omits roots whose host dotdir does not exist', () => {
    expect(managedArtifactSkillsRoots(makeCtx())).toEqual([]);
    mkdirSync(join(home, '.claude'), { recursive: true });
    expect(managedArtifactSkillsRoots(makeCtx())).toEqual([resolve(home, '.claude', 'skills')]);
  });

  test('a nested user layout activates on the host dotdir, not the leaf parent', () => {
    mkdirSync(join(home, '.pi'), { recursive: true });
    expect(managedArtifactSkillsRoots(makeCtx())).toContain(
      resolve(home, '.pi', 'agent', 'skills'),
    );
  });
});

describe('managedArtifactTimelinePaths', () => {
  test('project skill → versioned, with the .ok/skills key + SKILL.md leaf', () => {
    expect(managedArtifactTimelinePaths('__skill__/project/my-skill')).toEqual({
      managed: true,
      versioned: true,
      docKey: '.ok/skills/my-skill',
      filePath: '.ok/skills/my-skill/SKILL.md',
    });
  });

  test('global skill → managed but unversioned (no shadow history)', () => {
    expect(managedArtifactTimelinePaths('__skill__/global/my-skill')).toEqual({
      managed: true,
      versioned: false,
    });
  });

  test('ordinary doc → not managed', () => {
    expect(managedArtifactTimelinePaths('docs/getting-started')).toEqual({ managed: false });
  });
});

describe('__extskill__ editable-unmanaged skill — guarded external write-back', () => {
  const docName = '__extskill__/borrowed';
  let skillDir: string;

  beforeEach(() => {
    skillDir = mkdtempSync(join(tmpdir(), 'ok-extskill-'));
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: borrowed\n---\n\n# Original\n');
  });
  afterEach(() => {
    unregisterExternalSkill('borrowed');
    rmSync(skillDir, { recursive: true, force: true });
  });

  test('unregistered doc is a no-op (load seeds nothing, store writes nothing)', async () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    loadManagedArtifactDoc(doc, docName, ctx);
    expect(doc.getText('source').length).toBe(0);
    doc.transact(() => doc.getText('source').insert(0, 'edit'), 'agent');
    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('dropped-unresolvable');
  });

  test('load seeds from the real harness file; store writes back byte-identical', async () => {
    registerExternalSkill('borrowed', skillDir);
    const ctx = makeCtx();
    const doc = new Y.Doc();
    loadManagedArtifactDoc(doc, docName, ctx);
    expect(doc.getText('source').toString()).toBe('---\nname: borrowed\n---\n\n# Original\n');

    const edited = '---\nname: borrowed\n---\n\n# Edited café 日本語\n';
    doc.transact(() => {
      const src = doc.getText('source');
      src.delete(0, src.length);
      src.insert(0, edited);
    }, 'agent');
    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('persisted');
    // The write landed on the REAL harness file, verbatim (precedent #57).
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toBe(edited);
  });

  test('a bundle FILE (references/x) binds the ext-less doc name to the real .md and writes back', async () => {
    mkdirSync(join(skillDir, 'references'), { recursive: true });
    writeFileSync(join(skillDir, 'references', 'anti-patterns.md'), '# Anti-patterns\n');
    registerExternalSkill('borrowed', skillDir);
    const bundleDoc = '__extskill__/borrowed/references/anti-patterns';
    const ctx = makeCtx();
    const doc = new Y.Doc();
    loadManagedArtifactDoc(doc, bundleDoc, ctx);
    expect(doc.getText('source').toString()).toBe('# Anti-patterns\n');

    const edited = '# Anti-patterns edited\n';
    doc.transact(() => {
      const src = doc.getText('source');
      src.delete(0, src.length);
      src.insert(0, edited);
    }, 'agent');
    expect(await storeManagedArtifactDoc(doc, bundleDoc, 'agent', ctx)).toBe('persisted');
    expect(readFileSync(join(skillDir, 'references', 'anti-patterns.md'), 'utf-8')).toBe(edited);
  });

  test('first edit snapshots the pre-edit bytes out-of-tree (data-safety floor)', async () => {
    registerExternalSkill('borrowed', skillDir);
    const ctx = makeCtx();
    const doc = new Y.Doc();
    loadManagedArtifactDoc(doc, docName, ctx);
    doc.transact(() => {
      const src = doc.getText('source');
      src.delete(0, src.length);
      src.insert(0, 'clobbered\n');
    }, 'agent');
    await storeManagedArtifactDoc(doc, docName, 'agent', ctx);
    const backup = join(home, '.ok', 'edit-backups', 'borrowed', 'SKILL.md.bak');
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(backup, 'utf-8')).toBe('---\nname: borrowed\n---\n\n# Original\n');
  });
});

describe('a skill doc never RESURRECTS a bundle that is gone', () => {
  const docName = '__skill__/global/code-mode';

  beforeEach(adoptClaudeHost);

  function seedGlobalBundle(ctx: ManagedArtifactCtx): string {
    const bundleDir = dirname(managedArtifactAbsPath(docName, ctx));
    mkdirSync(join(bundleDir, 'references'), { recursive: true });
    writeFileSync(join(bundleDir, 'SKILL.md'), '---\nname: code-mode\n---\n\n# Code mode\n');
    writeFileSync(join(bundleDir, 'references', 'patterns.md'), '# Patterns\n');
    return bundleDir;
  }

  function editLive(doc: Y.Doc, text: string): void {
    doc.transact(() => {
      const src = doc.getText('source');
      src.delete(0, src.length);
      src.insert(0, text);
    }, 'agent');
  }

  test('a stale autosave after the bundle moved away writes NOTHING back', async () => {
    const ctx = makeCtx();
    const bundleDir = seedGlobalBundle(ctx);
    const doc = new Y.Doc();
    loadManagedArtifactDoc(doc, docName, ctx);

    rmSync(bundleDir, { recursive: true, force: true });

    editLive(doc, '---\nname: code-mode\n---\n\n# Code mode edited\n');
    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe(
      'dropped-container-gone',
    );
    expect(existsSync(bundleDir)).toBe(false);
  });

  test('the same is true for a bundle FILE doc, which would rebuild the dir chain', async () => {
    const ctx = makeCtx();
    const bundleDir = seedGlobalBundle(ctx);
    const fileDoc = '__skill__/global/code-mode/references/patterns';
    const doc = new Y.Doc();
    loadManagedArtifactDoc(doc, fileDoc, ctx);

    rmSync(bundleDir, { recursive: true, force: true });

    editLive(doc, '# Patterns edited\n');
    expect(await storeManagedArtifactDoc(doc, fileDoc, 'agent', ctx)).toBe(
      'dropped-container-gone',
    );
    expect(existsSync(bundleDir)).toBe(false);
  });

  test('a LIVE bundle still persists, and may still create dirs INSIDE itself', async () => {
    const ctx = makeCtx();
    const bundleDir = seedGlobalBundle(ctx);
    const doc = new Y.Doc();
    loadManagedArtifactDoc(doc, docName, ctx);
    editLive(doc, '---\nname: code-mode\n---\n\n# Still here\n');
    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('persisted');
    expect(readFileSync(join(bundleDir, 'SKILL.md'), 'utf-8')).toContain('# Still here');

    const fresh = '__skill__/global/code-mode/references/new-notes';
    const freshDoc = new Y.Doc();
    loadManagedArtifactDoc(freshDoc, fresh, ctx);
    editLive(freshDoc, '# New notes\n');
    expect(await storeManagedArtifactDoc(freshDoc, fresh, 'agent', ctx)).toBe('persisted');
    expect(readFileSync(join(bundleDir, 'references', 'new-notes.md'), 'utf-8')).toBe(
      '# New notes\n',
    );
  });
});

describe('the liveness rule covers external skills too', () => {
  function editLive(doc: Y.Doc, text: string): void {
    doc.transact(() => {
      const src = doc.getText('source');
      src.delete(0, src.length);
      src.insert(0, text);
    }, 'agent');
  }

  test('an external skill deleted by its harness is not rebuilt under the harness root', async () => {
    const dir = join(home, '.claude', 'skills', 'borrowed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: borrowed\n---\n\n# Original\n');
    registerExternalSkill('borrowed', dir);
    try {
      const ctx = makeCtx();
      const docName = '__extskill__/borrowed';
      const doc = new Y.Doc();
      loadManagedArtifactDoc(doc, docName, ctx);

      rmSync(dir, { recursive: true, force: true });

      editLive(doc, '---\nname: borrowed\n---\n\n# Resurrected\n');
      expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe(
        'dropped-container-gone',
      );
      expect(existsSync(dir)).toBe(false);
    } finally {
      unregisterExternalSkill('borrowed');
    }
  });
});
