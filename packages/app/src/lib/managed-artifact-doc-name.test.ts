import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import {
  filterOpenTabsForKnownTargets,
  isSkillBundleShapedPath,
  skillPreviewTabId,
  staleLocalSkillPreviewTwins,
} from '@/editor/editor-tabs';
import {
  __resetKnownProjectSkillDirsForTests,
  projectSkillBundleDirs,
  setKnownProjectSkillDirs,
} from '@/lib/known-skill-dirs';
import { skillEntryFileLiveDocName, skillEntryLiveDocName } from '@/lib/managed-artifact-doc-name';

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

  const pages = new Set(['plugins/ok/skills/bug-triage/SKILL']);
  const targets = { pages, folderPaths: new Set<string>(), assetPaths: new Set<string>() };

  test('the tab the sidebar opens is the page the index holds', () => {
    const tabId = skillEntryLiveDocName(aliased);
    expect(pages.has(tabId)).toBe(true);
    expect(filterOpenTabsForKnownTargets([tabId], targets)).toEqual([tabId]);
  });

  test('the canonical name is recognised as a skill bundle path', () => {
    setKnownProjectSkillDirs(projectSkillBundleDirs([aliased]));
    expect(isSkillBundleShapedPath(skillEntryLiveDocName(aliased))).toBe(true);
  });

  test('the derived set carries the alias dir as well as the canonical one', () => {
    expect(projectSkillBundleDirs([aliased])).toEqual(
      new Set(['.agents/skills/bug-triage', 'plugins/ok/skills/bug-triage']),
    );
  });
});

describe('staleLocalSkillPreviewTwins', () => {
  const previewId = (source: string, level: 'project' | 'global', flavor = 'detected' as const) =>
    skillPreviewTabId({ flavor, source, name: 'ai-sdk', subtitle: 'claude', level });

  test('the same skill under a moved source is a twin; a fresh open closes it', () => {
    const oldId = previewId('/cache/eng-3p/1.2.711/skills/ai-sdk', 'global');
    const newId = previewId('/cache/eng-3p/1.2.725/skills/ai-sdk', 'global');
    expect(
      staleLocalSkillPreviewTwins(
        [oldId, newId],
        { flavor: 'detected', name: 'ai-sdk', subtitle: 'claude', level: 'global' },
        newId,
      ),
    ).toEqual([oldId]);
  });

  test('a different level is a different preview, not a twin', () => {
    const globalId = previewId('/cache/x/skills/ai-sdk', 'global');
    const projectId = previewId('/cache/x/skills/ai-sdk', 'project');
    expect(
      staleLocalSkillPreviewTwins(
        [globalId, projectId],
        { flavor: 'detected', name: 'ai-sdk', subtitle: 'claude', level: 'global' },
        globalId,
      ),
    ).toEqual([]);
  });

  test('explore previews never match — one name from two repos is two previews', () => {
    const a = previewId('vercel/skills', 'project', 'explore');
    const b = previewId('acme/skills', 'project', 'explore');
    expect(
      staleLocalSkillPreviewTwins(
        [a, b],
        { flavor: 'explore', name: 'ai-sdk', subtitle: 'claude', level: 'project' },
        b,
      ),
    ).toEqual([]);
  });

  test('a same-name copy under a different host subtitle is NOT a twin', () => {
    const agentsId = skillPreviewTabId({
      flavor: 'detected',
      source: '/p/.agents/skills/ai-sdk',
      name: 'ai-sdk',
      subtitle: '.agents',
      level: 'global',
    });
    const claudeId = skillPreviewTabId({
      flavor: 'detected',
      source: '/p/.claude/skills/ai-sdk',
      name: 'ai-sdk',
      subtitle: 'claude',
      level: 'global',
    });
    expect(
      staleLocalSkillPreviewTwins(
        [agentsId, claudeId],
        { flavor: 'detected', name: 'ai-sdk', subtitle: 'claude', level: 'global' },
        claudeId,
      ),
    ).toEqual([]);
  });

  test('the freshly opened id is never its own twin', () => {
    const id = previewId('/cache/x/skills/ai-sdk', 'global');
    expect(
      staleLocalSkillPreviewTwins(
        [id],
        { flavor: 'detected', name: 'ai-sdk', subtitle: 'claude', level: 'global' },
        id,
      ),
    ).toEqual([]);
  });
});
