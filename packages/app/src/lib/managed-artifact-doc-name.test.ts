import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import { filterOpenTabsForKnownTargets, isSkillTabId } from '@/editor/editor-tabs';
import {
  __resetKnownProjectSkillDirsForTests,
  projectSkillBundleDirs,
  setKnownProjectSkillDirs,
} from '@/lib/known-skill-dirs';
import { skillEntryFileLiveDocName, skillEntryLiveDocName } from '@/lib/managed-artifact-doc-name';

/**
 * A project skill dir can be a SYMLINK to a canonical dir elsewhere in the
 * content tree (a repo that keeps its bundles in `plugins/<x>/skills/` and links
 * them into `.agents/skills/`). The document index holds ONE page per inode,
 * under the canonical name — so a tab opened at the alias name has no page and
 * the next page-list sync prunes it: the skill flickers open and vanishes, and
 * the surface falls back to Files. `/api/skills` reports the resolved
 * `canonicalPath`; every doc-name builder must prefer it.
 */
const aliased: SkillsListEntry = {
  scope: 'project',
  name: 'bug-triage',
  path: '.agents/skills/bug-triage/SKILL.md',
  canonicalPath: 'plugins/ok/skills/bug-triage/SKILL.md',
  installed: true,
  hosts: [],
};
const plain: SkillsListEntry = {
  scope: 'project',
  name: '1on1',
  path: '.agents/skills/1on1/SKILL.md',
  installed: true,
  hosts: [],
};

describe('skillEntryLiveDocName', () => {
  test('addresses an aliased skill by its canonical doc, not the symlink path', () => {
    expect(skillEntryLiveDocName(aliased)).toBe('plugins/ok/skills/bug-triage/SKILL');
  });

  test('leaves an ordinary in-place skill at its own path', () => {
    expect(skillEntryLiveDocName(plain)).toBe('.agents/skills/1on1/SKILL');
  });

  test('a global entry is unaffected (managed-artifact doc, not a content path)', () => {
    expect(skillEntryLiveDocName({ ...aliased, scope: 'global' })).toBe(
      '__skill__/global/bug-triage',
    );
  });
});

describe('skillEntryFileLiveDocName', () => {
  test('resolves a bundle file under the canonical dir', () => {
    expect(skillEntryFileLiveDocName(aliased, 'references/notes.md')).toBe(
      'plugins/ok/skills/bug-triage/references/notes',
    );
  });

  test('leaves an ordinary skill bundle file under its own dir', () => {
    expect(skillEntryFileLiveDocName(plain, 'references/notes.md')).toBe(
      '.agents/skills/1on1/references/notes',
    );
  });
});

describe('an aliased skill tab survives a page-list sync', () => {
  afterEach(() => {
    __resetKnownProjectSkillDirsForTests();
  });

  // `/api/pages` lists the canonical name only. The tab has to survive either
  // way now (skill docs are the reconciler's to close), but the doc the sidebar
  // opens must still be the indexed one — opening the alias would put a second
  // Y.Doc on the same inode.
  const pages = new Set(['plugins/ok/skills/bug-triage/SKILL']);
  const targets = { pages, folderPaths: new Set<string>(), assetPaths: new Set<string>() };

  test('the tab the sidebar opens is the page the index holds', () => {
    const tabId = skillEntryLiveDocName(aliased);
    expect(pages.has(tabId)).toBe(true);
    expect(filterOpenTabsForKnownTargets([tabId], targets)).toEqual([tabId]);
  });

  test('the canonical name still classifies as a Skills-surface tab', () => {
    // Otherwise the tab survives but lands in the Files tab strip.
    //
    // The canonical location is an ORDINARY path — nothing in `plugins/ok/skills/…`
    // distinguishes it from a repo that merely keeps markdown under a folder
    // called `skills`. So the surface decision reads the same
    // `/api/skills` entry the doc name was built from: `canonicalPath` is what
    // makes this location a skill, and no path-shape guess can substitute.
    setKnownProjectSkillDirs(projectSkillBundleDirs([aliased]));
    expect(isSkillTabId(skillEntryLiveDocName(aliased))).toBe(true);
  });

  test('the derived set carries the alias dir as well as the canonical one', () => {
    // `path` and `canonicalPath` both index as documents, so both belong in the
    // set. Asserted at the SET level on purpose: `.agents/skills/bug-triage/SKILL`
    // is already a skill doc by shape (`.agents` is a host root), so asserting
    // `isSkillTabId` on it would pass with the seeding removed — it would pin the
    // dot-root half while reading like a check of the derivation.
    expect(projectSkillBundleDirs([aliased])).toEqual(
      new Set(['.agents/skills/bug-triage', 'plugins/ok/skills/bug-triage']),
    );
  });
});
