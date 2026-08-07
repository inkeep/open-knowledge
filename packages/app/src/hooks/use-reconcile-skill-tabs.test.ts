import {
  type SkillsListEntry,
  skillFileLiveDocName,
  skillLiveDocName,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { skillFileTabId, skillPreviewTabId } from '@/editor/editor-tabs';
import {
  computeSkillTabReconcile,
  parseSkillTabDocName,
  skillFileForDocName,
  tabIdsForSkill,
  tabIdsForSkillFile,
} from './use-reconcile-skill-tabs';

/**
 * Unit coverage for the open-skill-tab reconciler: an agent/MCP/server-side
 * scope move or a delete only broadcasts `files` (no client tab retarget), so an
 * open SKILL or skill-FILE tab is left pointing at a doc that no longer exists.
 * The reconciler retargets a moved SKILL tab, and closes any tab (including a
 * reference-FILE tab) whose skill is gone — the lingering-tab-after-delete bug.
 *
 */
describe('parseSkillTabDocName', () => {
  test('parses a project skill content doc (SKILL-level, rel null)', () => {
    expect(parseSkillTabDocName('.ok/skills/demo/SKILL')).toEqual({
      scope: 'project',
      name: 'demo',
      rel: null,
    });
  });

  test('parses a global skill managed-artifact doc (SKILL-level, rel null)', () => {
    expect(parseSkillTabDocName(skillLiveDocName('global', 'demo'))).toEqual({
      scope: 'global',
      name: 'demo',
      rel: null,
    });
  });

  test('parses a project skill reference FILE doc (carries rel)', () => {
    expect(parseSkillTabDocName('.ok/skills/demo/references/notes')).toEqual({
      scope: 'project',
      name: 'demo',
      rel: 'notes',
    });
  });

  test('parses a global skill reference FILE doc (carries rel)', () => {
    expect(
      parseSkillTabDocName(skillFileLiveDocName('global', 'demo', 'references/notes')),
    ).toEqual({ scope: 'global', name: 'demo', rel: 'notes' });
  });

  test('rejects a non-skill doc (plain page, template content doc)', () => {
    expect(parseSkillTabDocName('notes/standup')).toBeNull();
    expect(parseSkillTabDocName('notes/.ok/templates/daily')).toBeNull();
  });
});

describe('tabIdsForSkill', () => {
  test('selects the deleted copy and its bundle files without closing its plugin preview', () => {
    const mainTab = skillLiveDocName('global', 'demo');
    const fileTab = skillFileTabId({
      scope: 'global',
      name: 'demo',
      path: 'references/notes.md',
    });
    const otherSkillTab = skillLiveDocName('global', 'other');
    const pluginPreviewTab = skillPreviewTabId({
      flavor: 'builtin',
      source: '/Users/test/.claude/plugins/cache/acme/plugin/1.0.0/skills/demo',
      name: 'demo',
      subtitle: 'Plugin',
      level: 'global',
    });

    expect(
      tabIdsForSkill([mainTab, fileTab, otherSkillTab, pluginPreviewTab], 'global', 'demo'),
    ).toEqual([mainTab, fileTab]);
  });
});

describe('tabIdsForSkillFile', () => {
  test('selects both tab shapes for the deleted file, and only that file', () => {
    const skill = { scope: 'project', name: 'demo', path: '.agents/skills/demo/SKILL.md' } as const;
    // A script opens as a dedicated skill-file tab; an editable `.md` reference
    // opens as an ordinary doc tab at its ext-less live doc name.
    const scriptTab = skillFileTabId({
      scope: 'project',
      name: 'demo',
      path: 'scripts/run.sh',
    });
    const refDocTab = '.agents/skills/demo/references/notes';
    const siblingRefTab = '.agents/skills/demo/references/other';
    const skillTab = '.agents/skills/demo/SKILL';

    expect(
      tabIdsForSkillFile([scriptTab, refDocTab, siblingRefTab, skillTab], skill, 'scripts/run.sh'),
    ).toEqual([scriptTab]);
    expect(
      tabIdsForSkillFile(
        [scriptTab, refDocTab, siblingRefTab, skillTab],
        skill,
        'references/notes.md',
      ),
    ).toEqual([refDocTab]);
  });
});

describe('skillFileForDocName', () => {
  const demo: SkillsListEntry = {
    scope: 'project',
    name: 'demo',
    path: '.agents/skills/demo/SKILL.md',
    installed: true,
    hosts: [],
  };

  test('resolves an editable reference doc tab back to its skill and bundle path', () => {
    expect(skillFileForDocName('.agents/skills/demo/references/notes', [demo], '.md')).toEqual({
      skill: demo,
      filePath: 'references/notes.md',
    });
  });

  test('carries a .mdx extension through, from the SAME doc name', () => {
    // Both extensions strip to this one doc name, so the round-trip guard cannot
    // separate them — whichever extension the caller supplies is the one acted
    // on. Pinned because it is the whole reason a delete miss has to report
    // failure rather than success.
    expect(skillFileForDocName('.agents/skills/demo/references/notes', [demo], '.mdx')).toEqual({
      skill: demo,
      filePath: 'references/notes.mdx',
    });
  });

  test('declines the SKILL doc, an unknown skill, and a plain page', () => {
    expect(skillFileForDocName('.agents/skills/demo/SKILL', [demo], '.md')).toBeNull();
    expect(skillFileForDocName('.agents/skills/other/references/notes', [demo], '.md')).toBeNull();
    expect(skillFileForDocName('notes/standup', [demo], '.md')).toBeNull();
  });

  test('declines a managed built-in (read-only, no mutate menu)', () => {
    const builtin: SkillsListEntry = { ...demo, managed: true };
    expect(
      skillFileForDocName('.agents/skills/demo/references/notes', [builtin], '.md'),
    ).toBeNull();
  });

  test('declines when the skill dir does not round-trip to the doc name', () => {
    // Same skill NAME, different on-disk dir — reconstructing against it would
    // address a file in the wrong folder.
    const moved: SkillsListEntry = { ...demo, path: '.claude/skills/demo/SKILL.md' };
    expect(skillFileForDocName('.agents/skills/demo/references/notes', [moved], '.md')).toBeNull();
  });
});

describe('computeSkillTabReconcile', () => {
  test('leaves a tab whose skill still exists at its scope untouched', () => {
    const actions = computeSkillTabReconcile(
      ['.ok/skills/demo/SKILL', 'notes/standup'],
      [{ scope: 'project', name: 'demo', path: '.agents/skills/demo/SKILL.md' }],
    );
    expect(actions).toEqual([]);
  });

  test('leaves a reference FILE tab whose skill still exists untouched', () => {
    const actions = computeSkillTabReconcile(
      ['.ok/skills/demo/references/notes'],
      [{ scope: 'project', name: 'demo', path: '.agents/skills/demo/SKILL.md' }],
    );
    expect(actions).toEqual([]);
  });

  test('retargets an orphaned project SKILL tab to the OTHER scope when the skill moved there', () => {
    // demo was moved project → global; its project content doc no longer exists,
    // but it now exists at global scope.
    const actions = computeSkillTabReconcile(
      ['.ok/skills/demo/SKILL'],
      [{ scope: 'global', name: 'demo', path: '~/.claude/skills/demo/SKILL.md' }],
    );
    expect(actions).toEqual([
      {
        kind: 'retarget',
        fromDocName: '.ok/skills/demo/SKILL',
        toDocName: skillLiveDocName('global', 'demo'),
      },
    ]);
  });

  test('retargets an orphaned global SKILL tab to the project entry REAL doc', () => {
    // The entry's real path drives the retarget — minting a shape here opened
    // phantom `.ok/skills` tabs for in-place skills (store-fossil class).
    const actions = computeSkillTabReconcile(
      [skillLiveDocName('global', 'demo')],
      [{ scope: 'project', name: 'demo', path: '.agents/skills/demo/SKILL.md' }],
    );
    expect(actions).toEqual([
      {
        kind: 'retarget',
        fromDocName: skillLiveDocName('global', 'demo'),
        toDocName: '.agents/skills/demo/SKILL',
      },
    ]);
  });

  test('closes an orphaned SKILL tab when the skill is gone from both scopes', () => {
    const actions = computeSkillTabReconcile(
      ['.ok/skills/gone/SKILL'],
      [{ scope: 'project', name: 'other', path: '.agents/skills/other/SKILL.md' }],
    );
    expect(actions).toEqual([{ kind: 'close', docName: '.ok/skills/gone/SKILL' }]);
  });

  test('closes a reference FILE tab when its skill is deleted (§2.4)', () => {
    // Editing `references/notes` when the skill is deleted — the file doc is gone,
    // so its tab must close rather than linger on a dead doc.
    const actions = computeSkillTabReconcile(['.ok/skills/demo/references/notes'], []);
    expect(actions).toEqual([{ kind: 'close', docName: '.ok/skills/demo/references/notes' }]);
  });

  test('closes a reference FILE tab when its skill moved scope (SKILL tab follows the move)', () => {
    // A file tab is not retargeted (its new-scope doc name is not reconstructed);
    // the SKILL tab retargets to the new scope, so the skill stays open.
    const actions = computeSkillTabReconcile(
      ['.ok/skills/demo/references/notes'],
      [{ scope: 'global', name: 'demo', path: '~/.claude/skills/demo/SKILL.md' }],
    );
    expect(actions).toEqual([{ kind: 'close', docName: '.ok/skills/demo/references/notes' }]);
  });

  test('ignores non-skill tabs entirely', () => {
    const actions = computeSkillTabReconcile(['notes/standup', 'notes/.ok/templates/daily'], []);
    expect(actions).toEqual([]);
  });
});
