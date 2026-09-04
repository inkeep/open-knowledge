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
    const actions = computeSkillTabReconcile(['.ok/skills/demo/references/notes'], []);
    expect(actions).toEqual([{ kind: 'close', docName: '.ok/skills/demo/references/notes' }]);
  });

  test('closes a reference FILE tab when its skill moved scope and the SKILL tab carries it', () => {
    const actions = computeSkillTabReconcile(
      ['.ok/skills/demo/SKILL', '.ok/skills/demo/references/notes'],
      [{ scope: 'global', name: 'demo', path: '~/.claude/skills/demo/SKILL.md' }],
    );
    expect(actions).toEqual([
      {
        kind: 'retarget',
        fromDocName: '.ok/skills/demo/SKILL',
        toDocName: skillLiveDocName('global', 'demo'),
      },
      { kind: 'close', docName: '.ok/skills/demo/references/notes' },
    ]);
  });

  test('retargets a lone bundle FILE tab to the new scope SKILL doc on a scope move', () => {
    const actions = computeSkillTabReconcile(
      ['.claude/skills/demo/mocking'],
      [{ scope: 'global', name: 'demo', path: '~/.claude/skills/demo/SKILL.md' }],
    );
    expect(actions).toEqual([
      {
        kind: 'retarget',
        fromDocName: '.claude/skills/demo/mocking',
        toDocName: skillLiveDocName('global', 'demo'),
      },
    ]);
  });

  test('promotes only ONE of several lone bundle FILE tabs, closing the rest', () => {
    const actions = computeSkillTabReconcile(
      ['.claude/skills/demo/mocking', '.claude/skills/demo/tests'],
      [{ scope: 'global', name: 'demo', path: '~/.claude/skills/demo/SKILL.md' }],
    );
    expect(actions).toEqual([
      {
        kind: 'retarget',
        fromDocName: '.claude/skills/demo/mocking',
        toDocName: skillLiveDocName('global', 'demo'),
      },
      { kind: 'close', docName: '.claude/skills/demo/tests' },
    ]);
  });

  test('closes a companion bundle tab when its skill is deleted', () => {
    expect(computeSkillTabReconcile(['.claude/skills/demo/mocking'], [])).toEqual([
      { kind: 'close', docName: '.claude/skills/demo/mocking' },
    ]);
    expect(computeSkillTabReconcile(['__skill__/global/demo/mocking'], [])).toEqual([
      { kind: 'close', docName: '__skill__/global/demo/mocking' },
    ]);
  });

  test('leaves a companion bundle tab alone while its skill still exists', () => {
    expect(
      computeSkillTabReconcile(
        ['.claude/skills/demo/mocking'],
        [{ scope: 'project', name: 'demo', path: '.claude/skills/demo/SKILL.md' }],
      ),
    ).toEqual([]);
  });

  test('ignores non-skill tabs entirely', () => {
    const actions = computeSkillTabReconcile(['notes/standup', 'notes/.ok/templates/daily'], []);
    expect(actions).toEqual([]);
  });
});

describe('scope-move window', () => {
  const projectTab = '.claude/skills/grill-me/SKILL';

  test('does NOT close a skill tab while its move is still in flight', () => {
    const actions = computeSkillTabReconcile([projectTab], [], () => true);
    expect(actions).toEqual([]);
  });

  test('still closes a tab for a skill that is genuinely gone', () => {
    const actions = computeSkillTabReconcile([projectTab], [], () => false);
    expect(actions).toEqual([{ kind: 'close', docName: projectTab }]);
  });

  test('retargets once the skill lands at its new scope', () => {
    const actions = computeSkillTabReconcile(
      [projectTab],
      [{ scope: 'global', name: 'grill-me', path: '.agents/skills/grill-me/SKILL.md' }],
      () => true,
    );
    expect(actions).toEqual([
      { kind: 'retarget', fromDocName: projectTab, toDocName: '__skill__/global/grill-me' },
    ]);
  });
});

describe('computeSkillTabReconcile round-trip (project -> global -> project)', () => {
  test('outbound hop retargets the open tab to the global doc', () => {
    const actions = computeSkillTabReconcile(
      ['.agents/skills/demo/SKILL'],
      [{ scope: 'global', name: 'demo', path: '.agents/skills/demo/SKILL.md' }],
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'retarget',
      fromDocName: '.agents/skills/demo/SKILL',
    });
  });

  test('return hop retargets the global tab back to the project doc', () => {
    const actions = computeSkillTabReconcile(
      ['__skill__/global/demo'],
      [{ scope: 'project', name: 'demo', path: '.agents/skills/demo/SKILL.md' }],
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'retarget',
      fromDocName: '__skill__/global/demo',
      toDocName: '.agents/skills/demo/SKILL',
    });
  });

  test('after the return hop settles, the followed tab is untouched — never closed', () => {
    const actions = computeSkillTabReconcile(
      ['.agents/skills/demo/SKILL'],
      [{ scope: 'project', name: 'demo', path: '.agents/skills/demo/SKILL.md' }],
    );
    expect(actions).toEqual([]);
  });

  test('a mid-flight snapshot with the skill at NEITHER scope defers while a write is pending', () => {
    const actions = computeSkillTabReconcile(['.agents/skills/demo/SKILL'], [], () => true);
    expect(actions).toEqual([]);
  });

  test('the same mid-flight snapshot with NO pending write closes (delete semantics preserved)', () => {
    const actions = computeSkillTabReconcile(['.agents/skills/demo/SKILL'], [], () => false);
    expect(actions).toEqual([{ kind: 'close', docName: '.agents/skills/demo/SKILL' }]);
  });
});
