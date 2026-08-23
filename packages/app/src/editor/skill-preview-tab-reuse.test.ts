import { describe, expect, test } from 'vitest';
import { findLocalSkillPreviewTabId, skillPreviewTabId } from './editor-tabs';

/**
 * A local-path preview's `source` is part of its tab identity but moves under
 * us — a plugin-cache path carries the plugin VERSION, and a detected skill
 * relocates when its installed copy is deleted and it is re-detected at its
 * original location. Without source-independent reuse the same skill opens a
 * SECOND, identically labelled tab, which is the duplicate-tab report.
 *
 */
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
    // The same skill after a plugin update: different path, same skill.
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
    // `explore` is not a local flavor, so it never matches the reuse probe.
    expect(
      findLocalSkillPreviewTabId(open, 'detected', 'find-skills', 'vercel-labs/skills', 'project'),
    ).toBeNull();
    expect(
      findLocalSkillPreviewTabId(open, 'builtin', 'find-skills', 'vercel-labs/skills', 'project'),
    ).toBeNull();
  });
});
