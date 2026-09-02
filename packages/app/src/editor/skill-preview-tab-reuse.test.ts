import { describe, expect, test } from 'vitest';
import { findLocalSkillPreviewTabId, skillPreviewTabId } from './editor-tabs';

describe('findLocalSkillPreviewTabId', () => {
  const pluginTab = (version: string) =>
    skillPreviewTabId({
      flavor: 'detected',
      source: `/Users/x/.claude/plugins/cache/team/eng/${version}/skills/1on1`,
      name: '1on1',
      subtitle: 'claude',
      level: 'project',
    });

  test('reuses the open tab for a detected skill whose plugin version bumped', () => {
    const open = [pluginTab('1.2.679')];
    expect(findLocalSkillPreviewTabId(open, 'detected', '1on1', 'claude', 'project')).toBe(open[0]);
    expect(pluginTab('1.2.680')).not.toBe(open[0]);
  });

  test('reuses the open tab for a built-in whose bundle path moved', () => {
    const open = [
      skillPreviewTabId({
        flavor: 'builtin',
        source: '/old/path/skills/open-knowledge',
        name: 'open-knowledge',
        subtitle: '',
        level: 'global',
      }),
    ];
    expect(findLocalSkillPreviewTabId(open, 'builtin', 'open-knowledge', '', 'global')).toBe(
      open[0],
    );
  });

  test('does not cross flavors or levels', () => {
    const open = [pluginTab('1.2.679')];
    expect(findLocalSkillPreviewTabId(open, 'builtin', '1on1', 'claude', 'project')).toBeNull();
    expect(findLocalSkillPreviewTabId(open, 'detected', '1on1', 'claude', 'global')).toBeNull();
  });

  test('a different host subtitle is a different preview — never reused across', () => {
    const open = [
      skillPreviewTabId({
        flavor: 'detected',
        source: '/p/.claude/skills/1on1',
        name: '1on1',
        subtitle: 'claude',
        level: 'project',
      }),
    ];
    expect(findLocalSkillPreviewTabId(open, 'detected', '1on1', '.agents', 'project')).toBeNull();
  });

  test('leaves explore previews alone — same name, two repos is two previews', () => {
    const open = [
      skillPreviewTabId({
        flavor: 'explore',
        source: 'vercel-labs/skills',
        name: 'find-skills',
        subtitle: 'vercel-labs/skills',
        level: 'project',
      }),
    ];
    expect(
      findLocalSkillPreviewTabId(open, 'detected', 'find-skills', 'vercel-labs/skills', 'project'),
    ).toBeNull();
    expect(
      findLocalSkillPreviewTabId(open, 'builtin', 'find-skills', 'vercel-labs/skills', 'project'),
    ).toBeNull();
  });
});
