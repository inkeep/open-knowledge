import { describe, expect, test } from 'bun:test';
import { skillLiveDocName } from '@inkeep/open-knowledge-core';
import { computeSkillTabReconcile, parseSkillTabDocName } from './use-reconcile-skill-tabs';

/**
 * Unit coverage for the open-skill-tab reconciler: an agent/MCP/server-side
 * scope move only broadcasts `files` (no client tab retarget), so an open skill
 * tab is left pointing at a doc that no longer exists. The reconciler retargets
 * it to the moved skill's new scope, or closes it when the skill is gone.
 *
 */
describe('parseSkillTabDocName', () => {
  test('parses a project skill content doc', () => {
    expect(parseSkillTabDocName('.ok/skills/demo/SKILL')).toEqual({
      scope: 'project',
      name: 'demo',
    });
  });

  test('parses a global skill managed-artifact doc', () => {
    expect(parseSkillTabDocName(skillLiveDocName('global', 'demo'))).toEqual({
      scope: 'global',
      name: 'demo',
    });
  });

  test('rejects a non-skill doc (plain page, template, ref)', () => {
    expect(parseSkillTabDocName('notes/standup')).toBeNull();
    expect(parseSkillTabDocName('__template__/notes/daily')).toBeNull();
    // A bundle reference is NOT the skill tab itself (it has its own doc).
    expect(parseSkillTabDocName('.ok/skills/demo/references/notes')).toBeNull();
  });
});

describe('computeSkillTabReconcile', () => {
  test('leaves a tab whose skill still exists at its scope untouched', () => {
    const actions = computeSkillTabReconcile(
      ['.ok/skills/demo/SKILL', 'notes/standup'],
      [{ scope: 'project', name: 'demo' }],
    );
    expect(actions).toEqual([]);
  });

  test('retargets an orphaned project tab to the OTHER scope when the skill moved there', () => {
    // demo was moved project → global; its project content doc no longer exists,
    // but it now exists at global scope.
    const actions = computeSkillTabReconcile(
      ['.ok/skills/demo/SKILL'],
      [{ scope: 'global', name: 'demo' }],
    );
    expect(actions).toEqual([
      {
        kind: 'retarget',
        fromDocName: '.ok/skills/demo/SKILL',
        toDocName: skillLiveDocName('global', 'demo'),
      },
    ]);
  });

  test('retargets an orphaned global tab to project when the skill moved there', () => {
    const actions = computeSkillTabReconcile(
      [skillLiveDocName('global', 'demo')],
      [{ scope: 'project', name: 'demo' }],
    );
    expect(actions).toEqual([
      {
        kind: 'retarget',
        fromDocName: skillLiveDocName('global', 'demo'),
        toDocName: skillLiveDocName('project', 'demo'),
      },
    ]);
  });

  test('closes an orphaned tab when the skill is gone from both scopes', () => {
    const actions = computeSkillTabReconcile(
      ['.ok/skills/gone/SKILL'],
      [{ scope: 'project', name: 'other' }],
    );
    expect(actions).toEqual([{ kind: 'close', docName: '.ok/skills/gone/SKILL' }]);
  });

  test('ignores non-skill tabs entirely', () => {
    const actions = computeSkillTabReconcile(['notes/standup', '__template__/notes/daily'], []);
    expect(actions).toEqual([]);
  });
});
