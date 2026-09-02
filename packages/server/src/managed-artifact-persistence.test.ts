import {
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
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { FILE_WATCHER_ORIGIN } from './external-change.ts';
import { registerExternalSkill, unregisterExternalSkill } from './external-skill-registry.ts';
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

let projectDir: string;
let home: string;
let reconciled: Map<string, string>;

function makeCtx(): ManagedArtifactCtx {
  return {
    projectDir,
    homedirOverride: home,
    lkgCache: new Map<string, string>(),
    setReconciledBase: (n, c) => reconciled.set(n, c),
    getReconciledBase: (n) => reconciled.get(n),
  };
}

function adoptClaudeHost(): void {
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'ok-ma-proj-'));
  home = mkdtempSync(join(tmpdir(), 'ok-ma-home-'));
  reconciled = new Map();
});
afterEach(() => {
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

  test('store is a no-op for the load/reconcile origin', async () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, SRC), 'agent');
    expect(await storeManagedArtifactDoc(doc, docName, FILE_WATCHER_ORIGIN, ctx)).toBe('no-op');
    expect(existsSync(managedArtifactAbsPath(docName, ctx))).toBe(false);
  });

  test('project-skill synthetic doc is INERT in load + store (double-doc guard)', async () => {
    const ctx = makeCtx();
    const projectDocName = '__skill__/project/demo';
    const projectPath = managedArtifactAbsPath(projectDocName, ctx);

    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, SRC), 'agent');
    expect(await storeManagedArtifactDoc(doc, projectDocName, 'agent', ctx)).toBe('no-op');
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
    expect(await storeManagedArtifactDoc(doc, templateDocName, 'agent', ctx)).toBe('no-op');

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

describe('concurrent-writer reconcile', () => {
  const docName = '__skill__/global/demo';

  beforeEach(() => {
    adoptClaudeHost();
    mkdirSync(dirname(managedArtifactAbsPath(docName, makeCtx())), { recursive: true });
  });

  test('store reconciles instead of clobbering when disk diverged from LKG', async () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    doc.transact(
      () => doc.getText('source').insert(0, '---\nname: demo\ndescription: a\n---\nA\n'),
      'agent',
    );
    await storeManagedArtifactDoc(doc, docName, 'agent', ctx);

    const path = managedArtifactAbsPath(docName, ctx);
    const otherWriter = '---\nname: demo\ndescription: a\n---\nOTHER WRITER\n';
    writeFileSync(path, otherWriter, 'utf-8');

    doc.transact(
      () => doc.getText('source').insert(doc.getText('source').length, 'local edit'),
      'agent',
    );
    const outcome = await storeManagedArtifactDoc(doc, docName, 'agent', ctx);
    expect(outcome).toBe('reconciled');
    expect(readFileSync(path, 'utf-8')).toBe(otherWriter);
    expect(reconciled.get(docName)).toBe(otherWriter);

    const safe = docName.replace(/[^A-Za-z0-9._-]+/g, '__');
    const stashDir = resolve(home, '.ok', 'edit-backups', 'discarded', safe);
    const stashed = readdirSync(stashDir);
    expect(stashed).toHaveLength(1);
    expect(readFileSync(resolve(stashDir, stashed[0] as string), 'utf-8')).toContain('local edit');
  });

  test('reconcile invokes beforeReconcileDivergence with the live and disk content', async () => {
    const calls: Array<{ docName: string; live: string; disk: string }> = [];
    const ctx: ManagedArtifactCtx = {
      ...makeCtx(),
      beforeReconcileDivergence: (_doc, name, live, disk) => {
        calls.push({ docName: name, live, disk });
        return undefined;
      },
    };
    const doc = new Y.Doc();
    const v1 = '---\nname: demo\ndescription: a\n---\nA\n';
    doc.transact(() => doc.getText('source').insert(0, v1), 'agent');
    await storeManagedArtifactDoc(doc, docName, 'agent', ctx);
    expect(calls).toHaveLength(0);

    const path = managedArtifactAbsPath(docName, ctx);
    const otherWriter = '---\nname: demo\ndescription: a\n---\nOTHER WRITER\n';
    writeFileSync(path, otherWriter, 'utf-8');

    doc.transact(
      () => doc.getText('source').insert(doc.getText('source').length, 'local edit'),
      'agent',
    );
    const live = doc.getText('source').toString();
    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('reconciled');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.docName).toBe(docName);
    expect(calls[0]?.live).toBe(live);
    expect(calls[0]?.live).toContain('local edit');
    expect(calls[0]?.disk).toBe(otherWriter);
  });

  test('reconcile still returns reconciled when no checkpoint hook is wired', async () => {
    const ctx = makeCtx();
    expect(ctx.beforeReconcileDivergence).toBeUndefined();
    const doc = new Y.Doc();
    doc.transact(
      () => doc.getText('source').insert(0, '---\nname: demo\ndescription: a\n---\nA\n'),
      'agent',
    );
    await storeManagedArtifactDoc(doc, docName, 'agent', ctx);
    const path = managedArtifactAbsPath(docName, ctx);
    writeFileSync(path, '---\nname: demo\ndescription: a\n---\nOTHER\n', 'utf-8');
    doc.transact(() => doc.getText('source').insert(doc.getText('source').length, 'x'), 'agent');
    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('reconciled');
  });

  test('applyExternalManagedArtifactChange imports disk bytes into the live doc', () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    const raw = '---\nname: demo\ndescription: a\n---\nEXTERNAL\n';
    expect(applyExternalManagedArtifactChange(doc, docName, raw, ctx)).toBe('applied');
    expect(doc.getText('source').toString()).toBe(raw);
    expect(reconciled.get(docName)).toBe(raw);
  });

  test('applyExternalManagedArtifactChange is a no-op for a null doc', () => {
    const ctx = makeCtx();
    expect(applyExternalManagedArtifactChange(null, docName, 'whatever', ctx)).toBe('no-op');
    expect(reconciled.has(docName)).toBe(false);
  });

  test('applyExternalManagedArtifactChange short-circuits a self-write (content === LKG)', () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    const raw = '---\nname: demo\ndescription: a\n---\nBODY\n';
    ctx.lkgCache.set(docName, raw);
    expect(applyExternalManagedArtifactChange(doc, docName, raw, ctx)).toBe('no-op');
    expect(doc.getText('source').toString()).toBe('');
    expect(reconciled.has(docName)).toBe(false);
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
    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('no-op');
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
    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('no-op');
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
    expect(await storeManagedArtifactDoc(doc, fileDoc, 'agent', ctx)).toBe('no-op');
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
      expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('no-op');
      expect(existsSync(dir)).toBe(false);
    } finally {
      unregisterExternalSkill('borrowed');
    }
  });
});
