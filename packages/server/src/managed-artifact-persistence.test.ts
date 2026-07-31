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
import { join, resolve } from 'node:path';
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
  test('global with no native/store resolves to the IN-PLACE default home, never the store', () => {
    const ctx = makeCtx();
    // Project managed docs keep the legacy `.ok/skills` content path (project
    // skills open as content docs; this branch is effectively dead).
    expect(managedArtifactAbsPath('__skill__/project/my-skill', ctx)).toBe(
      resolve(projectDir, '.ok', 'skills', 'my-skill', 'SKILL.md'),
    );
    // Store retirement: a global skill with neither a native copy nor a store
    // resident resolves to the in-place default home — NEVER `~/.ok/skills`.
    // Defaulting to the store re-created the remnant on every stray global write
    // (a global doc autosaving after the skill was moved away). Fresh home has no
    // editor dirs → `.claude/skills`.
    expect(managedArtifactAbsPath('__skill__/global/my-skill', ctx)).toBe(
      resolve(home, '.claude', 'skills', 'my-skill', 'SKILL.md'),
    );
  });

  test('global skill absent from the store resolves to its native editor dir (R12)', () => {
    const ctx = makeCtx();
    // Native-only skill: `~/.claude/skills/native-one` and no store entry.
    const nativeDir = resolve(home, '.claude', 'skills', 'native-one');
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(join(nativeDir, 'SKILL.md'), '---\nname: native-one\ndescription: d\n---\n# N');
    expect(managedArtifactAbsPath('__skill__/global/native-one', ctx)).toBe(
      resolve(nativeDir, 'SKILL.md'),
    );
    // Bundle files resolve inside the native dir too.
    expect(managedArtifactAbsPath('__skill__/global/native-one/references/x', ctx)).toBe(
      resolve(nativeDir, 'references', 'x.md'),
    );
    // Store retirement: NATIVE wins even when a legacy store resident also
    // exists (was: store wins). The store is drained, never re-blessed.
    const storeDir = resolve(home, '.ok', 'skills', 'native-one');
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, 'SKILL.md'), '---\nname: native-one\ndescription: d\n---\n# S');
    expect(managedArtifactAbsPath('__skill__/global/native-one', ctx)).toBe(
      resolve(nativeDir, 'SKILL.md'),
    );
    // A PROJECT-scope name never probes user dirs.
    expect(managedArtifactAbsPath('__skill__/project/native-one', ctx)).toBe(
      resolve(projectDir, '.ok', 'skills', 'native-one', 'SKILL.md'),
    );
  });

  test('rejects path-escape + malformed names (security)', () => {
    const ctx = makeCtx();
    for (const bad of [
      '__skill__/project/..',
      '__skill__/project/../../etc/passwd',
      '__skill__/project/foo/../bar', // rel escape (`..` in the bundle path)
      '__skill__/global/foo/references/../../escape', // rel escape (global)
      '__skill__/project/Foo', // uppercase name
      '__skill__/project/foo.bar', // dot in name
      '__skill__/project/', // empty name
      '__skill__/bogus/foo', // bad scope
      'notes/foo', // not managed-artifact
    ]) {
      expect(() => managedArtifactAbsPath(bad, ctx)).toThrow();
    }
  });

  test('resolves a bundle FILE (rel) inside the resolved skill dir (per-file editability)', () => {
    const ctx = makeCtx();
    // Store retirement: with no native/store, a global skill resolves under the
    // in-place default home (`.claude/skills` in a fresh home), not `.ok/skills`.
    // Not-yet-created file → ext-less doc name binds to `.md` by default.
    expect(managedArtifactAbsPath('__skill__/global/demo/references/patterns', ctx)).toBe(
      resolve(home, '.claude', 'skills', 'demo', 'references', 'patterns.md'),
    );
    // An existing `.mdx` on disk wins over the default `.md` (resolved dir).
    const dir = resolve(home, '.claude', 'skills', 'demo', 'references');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'guide.mdx'), '# G\n', 'utf-8');
    expect(managedArtifactAbsPath('__skill__/global/demo/references/guide', ctx)).toBe(
      resolve(dir, 'guide.mdx'),
    );
  });

  test('store retirement: a legacy store resident with NO native is still read (drain-pending)', () => {
    const ctx = makeCtx();
    // Only a `~/.ok/skills` resident, no native copy: reads still resolve to it
    // so an un-drained skill stays editable until the boot migration relocates
    // it. (Once a native exists, native wins — covered above.)
    const storeDir = resolve(home, '.ok', 'skills', 'legacy-only');
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, 'SKILL.md'), '---\nname: legacy-only\ndescription: d\n---\n# L');
    expect(managedArtifactAbsPath('__skill__/global/legacy-only', ctx)).toBe(
      resolve(storeDir, 'SKILL.md'),
    );
  });

  test('templates resolve folder-addressed under <folder>/.ok/templates/<name>.md', () => {
    const ctx = makeCtx();
    // Root template (empty folder).
    expect(managedArtifactAbsPath('__template__/daily-note', ctx)).toBe(
      resolve(projectDir, '.ok', 'templates', 'daily-note.md'),
    );
    // Nested-folder template.
    expect(managedArtifactAbsPath('__template__/notes/sub/meeting', ctx)).toBe(
      resolve(projectDir, 'notes', 'sub', '.ok', 'templates', 'meeting.md'),
    );
  });

  test('rejects template path-escape + malformed names (security)', () => {
    const ctx = makeCtx();
    for (const bad of [
      '__template__/', // empty
      '__template__/../evil', // folder escape
      '__template__/notes/../../etc/passwd',
      '__template__/notes/bad.name', // dot in name
      '__template__/notes/bad name', // space in name
    ]) {
      expect(() => managedArtifactAbsPath(bad, ctx)).toThrow();
    }
  });
});

describe('store/load round-trip', () => {
  const SRC = '---\nname: demo\ndescription: a demo skill\n---\n\n# Demo\n\nBody line.\n';
  // Global scope — the surviving managed-artifact load/store flow. Project
  // skills are content docs now (guarded to a no-op in load/store).
  const docName = '__skill__/global/demo';

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
    // A project skill is a CONTENT doc (`.ok/skills/<name>/SKILL`); the synthetic
    // `__skill__/project/<name>` must NEVER become a second CRDT doc competing for
    // the same file. load early-returns (seeds nothing) and store no-ops — the
    // sole defense against double-doc corruption. This is the only
    // test that exercises that guard, on a mutating write spine.
    const ctx = makeCtx();
    const projectDocName = '__skill__/project/demo';
    const projectPath = managedArtifactAbsPath(projectDocName, ctx);

    // store: a populated doc must NOT persist under the synthetic project name.
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, SRC), 'agent');
    expect(await storeManagedArtifactDoc(doc, projectDocName, 'agent', ctx)).toBe('no-op');
    expect(existsSync(projectPath)).toBe(false);

    // load: even with a real file on disk at the resolved project path, the
    // synthetic doc seeds NOTHING (the guard returns before reading) — so it
    // can't shadow the content doc.
    mkdirSync(resolve(projectPath, '..'), { recursive: true });
    writeFileSync(projectPath, SRC, 'utf-8');
    const fresh = new Y.Doc();
    loadManagedArtifactDoc(fresh, projectDocName, ctx);
    expect(fresh.getText('source').toString()).toBe('');
    expect(fresh.getXmlFragment('default').length).toBe(0);
  });

  test('store is a no-op when content equals LKG', async () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    doc.transact(() => doc.getText('source').insert(0, SRC), 'agent');
    expect(await storeManagedArtifactDoc(doc, docName, 'agent', ctx)).toBe('persisted');
    // second store, unchanged content → no-op
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

  // Anti-duplication guard: every seed-from-disk is a NEW Yjs lineage, so the
  // load mints a fresh `lifecycle.epoch`. The client's lineage guard reads this
  // to DISCARD a stale IndexedDB copy on reconnect instead of merging it — which
  // is what stops the global-skill self-duplication (two independent same-text
  // seeds concatenating). Mirrors the content-persistence epoch mint.
  test('load mints a fresh lineage epoch on each seed-from-disk', () => {
    const path = managedArtifactAbsPath(docName, makeCtx());
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, SRC, 'utf-8');

    const docA = new Y.Doc();
    loadManagedArtifactDoc(docA, docName, makeCtx());
    const epochA = docA.getMap('lifecycle').get(LINEAGE_EPOCH_KEY);
    expect(typeof epochA).toBe('string');
    expect((epochA as string).length).toBeGreaterThan(0);

    // A second fresh-doc load (the reseed-after-eviction case) is a DISTINCT
    // lineage → a different epoch, so the client can tell the lineage changed.
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
  // Global scope — the surviving managed-artifact load/store flow. Project
  // skills are content docs now (guarded to a no-op in load/store).
  const docName = '__skill__/global/demo';

  test('store reconciles instead of clobbering when disk diverged from LKG', async () => {
    const ctx = makeCtx();
    const doc = new Y.Doc();
    doc.transact(
      () => doc.getText('source').insert(0, '---\nname: demo\ndescription: a\n---\nA\n'),
      'agent',
    );
    await storeManagedArtifactDoc(doc, docName, 'agent', ctx); // LKG = 'A' version

    // Another writer changes the file underneath us.
    const path = managedArtifactAbsPath(docName, ctx);
    const otherWriter = '---\nname: demo\ndescription: a\n---\nOTHER WRITER\n';
    writeFileSync(path, otherWriter, 'utf-8');

    // Our doc now has a different local edit; store should reconcile (import disk), not clobber.
    doc.transact(
      () => doc.getText('source').insert(doc.getText('source').length, 'local edit'),
      'agent',
    );
    const outcome = await storeManagedArtifactDoc(doc, docName, 'agent', ctx);
    expect(outcome).toBe('reconciled');
    expect(readFileSync(path, 'utf-8')).toBe(otherWriter); // disk preserved
    expect(reconciled.get(docName)).toBe(otherWriter);

    // R7 data-safety: the user's replaced bytes are stashed out-of-tree,
    // bounded per doc — "keep mine" stays recoverable.
    const safe = docName.replace(/[^A-Za-z0-9._-]+/g, '__');
    const stashDir = resolve(home, '.ok', 'edit-backups', 'discarded', safe);
    const stashed = readdirSync(stashDir);
    expect(stashed).toHaveLength(1);
    expect(readFileSync(resolve(stashDir, stashed[0] as string), 'utf-8')).toContain('local edit');
  });

  /**
   * Global skills are the reconcile arm's primary reachable case — project
   * skills return 'no-op' before it, so the reachable set is global skills plus
   * templates. They also live outside any project shadow repo, which makes them
   * the unanchorable half of the site: the hook still has to run so the counter
   * and the ring breadcrumb fire, even though there is nowhere to file an
   * anchor. The booted template test pins the anchored half; this pins the hand-
   * off, which is what tells the anchored half it will ever be reached.
   */
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
    expect(calls).toHaveLength(0); // a clean store must not look like a reconcile

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
    // The live bytes handed to the hook are the ones about to be discarded, and
    // the disk bytes are the baseline the detector measures against. Getting
    // these backwards would checkpoint the content that survives.
    expect(calls[0]?.live).toBe(live);
    expect(calls[0]?.live).toContain('local edit');
    expect(calls[0]?.disk).toBe(otherWriter);
  });

  test('reconcile still returns reconciled when no checkpoint hook is wired', async () => {
    // Ephemeral boots and unit rigs build a ctx without the hook. The repair
    // must not depend on the anchor being available.
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
    // Simulate persistence having just written `raw` to disk (sets LKG).
    ctx.lkgCache.set(docName, raw);
    expect(applyExternalManagedArtifactChange(doc, docName, raw, ctx)).toBe('no-op');
    // Doc untouched — Y.Text stays empty, no reconcile.
    expect(doc.getText('source').toString()).toBe('');
    expect(reconciled.has(docName)).toBe(false);
  });
});

describe('managedArtifactDocNameForPath (reverse resolver)', () => {
  test('maps a global SKILL.md leaf back to its doc name; project paths are content', () => {
    const ctx = makeCtx();
    // Project skills are content docs now — a project skill path no longer maps
    // to a synthetic managed-artifact name.
    expect(
      managedArtifactDocNameForPath(resolve(projectDir, '.ok/skills/my-skill/SKILL.md'), ctx),
    ).toBeNull();
    // Global skills still reconcile through the dedicated managed-artifact route.
    expect(
      managedArtifactDocNameForPath(resolve(home, '.ok/skills/notes-helper/SKILL.md'), ctx),
    ).toBe('__skill__/global/notes-helper');
    // A global skill's `.md`/`.mdx` bundle FILE maps to its per-file live doc
    // (ext-less); non-md files (scripts, binary) do not.
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
    // The skills watcher watches every global root, so the reverse mapping must
    // cover the native user roots too — a `.agents`/`.claude` event that maps to
    // null is silently dropped and an open-but-empty doc never seeds from disk.
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

  test('maps a template .md leaf back to its folder-addressed doc name', () => {
    const ctx = makeCtx();
    // Root template.
    expect(managedArtifactDocNameForPath(resolve(projectDir, '.ok/templates/daily.md'), ctx)).toBe(
      '__template__/daily',
    );
    // Nested-folder template.
    expect(
      managedArtifactDocNameForPath(resolve(projectDir, 'notes/sub/.ok/templates/meeting.md'), ctx),
    ).toBe('__template__/notes/sub/meeting');
  });

  test('round-trips with managedArtifactAbsPath (skills + templates)', () => {
    const ctx = makeCtx();
    // Project skills omitted — they are content docs, so their disk path does
    // not round-trip through the managed-artifact reverse resolver anymore.
    for (const name of [
      '__skill__/global/beta-2',
      '__skill__/global/beta-2/references/patterns', // per-file bundle doc
      '__template__/daily',
      '__template__/notes/sub/meeting',
    ]) {
      expect(managedArtifactDocNameForPath(managedArtifactAbsPath(name, ctx), ctx)).toBe(name);
    }
  });

  test('rejects malformed / false-match template paths', () => {
    const ctx = makeCtx();
    for (const bad of [
      resolve(projectDir, '.ok/templates/a/b.md'), // nested below templates dir
      resolve(projectDir, '.ok/templates/Bad Name.md'), // space in name
      resolve(projectDir, 'x.ok/templates/t.md'), // `.ok/templates` not a clean boundary
    ]) {
      expect(managedArtifactDocNameForPath(bad, ctx)).toBeNull();
    }
  });

  test('returns null for non-leaf / malformed / out-of-root paths', () => {
    const ctx = makeCtx();
    for (const bad of [
      resolve(projectDir, '.ok/skills/SKILL.md'), // no <name> segment
      resolve(projectDir, '.ok/skills/a/b/SKILL.md'), // nested
      resolve(projectDir, '.ok/skills/my-skill/OTHER.md'), // not SKILL.md
      resolve(projectDir, '.ok/skills/Bad/SKILL.md'), // uppercase name
      resolve(projectDir, '.ok/templates/t/SKILL.md'), // not a skills root
      resolve(projectDir, 'notes/SKILL.md'), // outside .ok/skills
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

  test('templates → folder-addressed .ok/templates key + template- subject', () => {
    expect(managedArtifactContributorAttribution('__template__/daily')).toEqual({
      docKey: '.ok/templates/daily',
      subject: 'template-edit: .ok/templates/daily.md',
    });
    expect(managedArtifactContributorAttribution('__template__/notes/sub/meeting')).toEqual({
      docKey: 'notes/sub/.ok/templates/meeting',
      subject: 'template-edit: notes/sub/.ok/templates/meeting.md',
    });
  });

  test('non-managed-artifact name → null', () => {
    expect(managedArtifactContributorAttribution('notes/foo')).toBeNull();
  });
});

describe('managedArtifactSkillsRoots', () => {
  test('covers every native user root, with the legacy store included but not privileged', () => {
    const ctx = makeCtx();
    const roots = managedArtifactSkillsRoots(ctx);
    // Global skills live IN PLACE, so the native roots are what matters here.
    expect(roots).toContain(resolve(home, '.claude', 'skills'));
    expect(roots).toContain(resolve(home, '.agents', 'skills'));
    // The retired store is still watched — a resident that collides at its
    // migration target never drains — but it is an ordinary member of the list,
    // NOT the first entry it used to be pinned as.
    expect(roots).toContain(resolve(home, '.ok', 'skills'));
    expect(roots[0]).not.toBe(resolve(home, '.ok', 'skills'));
    // All under the ctx home — no absolute leaks from another machine state.
    expect(roots.every((r) => r.startsWith(home))).toBe(true);
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

  test('template → versioned, folder-addressed key + <name>.md leaf', () => {
    expect(managedArtifactTimelinePaths('__template__/docs/guides/note')).toEqual({
      managed: true,
      versioned: true,
      docKey: 'docs/guides/.ok/templates/note',
      filePath: 'docs/guides/.ok/templates/note.md',
    });
    expect(managedArtifactTimelinePaths('__template__/note')).toEqual({
      managed: true,
      versioned: true,
      docKey: '.ok/templates/note',
      filePath: '.ok/templates/note.md',
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
  let skillDir: string; // a detected skill living OUTSIDE projectDir/home

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
    // The reference-file doc name is ext-less; it must resolve to the real
    // `references/anti-patterns.md` on disk (not an extension-less path), load
    // its bytes, and autosave back to that same file.
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
    // The snapshot is the PRE-edit content, so a bad edit stays recoverable.
    expect(readFileSync(backup, 'utf-8')).toBe('---\nname: borrowed\n---\n\n# Original\n');
  });
});
