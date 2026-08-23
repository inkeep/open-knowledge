import { describe, expect, test } from 'vitest';
import { skillClusterHosts, skillDisplayName } from './skill-scope';

describe('skillDisplayName', () => {
  // Load-bearing precisely BECAUSE existing installs are never renamed: the long
  // prefixed names live indefinitely, and without the strip they render in full
  // in the sidebar and tab labels — the overflow this helper exists to prevent.
  test('strips the pack prefix from a pre-rename install', () => {
    expect(skillDisplayName('open-knowledge-pack-software-lifecycle')).toBe('software-lifecycle');
    expect(skillDisplayName('open-knowledge-pack-knowledge-base-research')).toBe(
      'knowledge-base-research',
    );
  });

  test('leaves post-rename and user-authored names alone', () => {
    for (const name of ['note-taking', 'research-with-sources', 'my-own-skill', 'open-knowledge']) {
      expect(skillDisplayName(name)).toBe(name);
    }
  });

  test('does not strip a name that merely contains the prefix', () => {
    expect(skillDisplayName('my-open-knowledge-pack-thing')).toBe('my-open-knowledge-pack-thing');
  });
});

describe('skillClusterHosts — plugin provider', () => {
  test('the provider of a plugin-identity skill rides the cluster without a location', () => {
    // Claude loads the skill via the plugin; it owns no row, exactly like an
    // alias viewer, but the cluster must say it reads the skill.
    const hosts = skillClusterHosts({
      scope: 'project',
      name: 'linux-vm',
      path: '.agents/skills/linux-vm/SKILL.md',
      installed: true,
      hosts: ['agents'],
      plugin: { name: 'ok', marketplace: 'inkeep-agents-private', provider: 'claude' },
    } as never);
    expect(hosts).toContain('claude');
    expect(hosts).toContain('agents');
  });

  test('a copy synced OUT of a plugin also shows the provider — via its origin', () => {
    // The eng-plugin copies under .agents carry no `plugin` (they are copies,
    // not the plugin itself); their plugin link is the origin's cache path.
    // Claude still loads the skill via that plugin, so it rides the cluster.
    const hosts = skillClusterHosts({
      scope: 'project',
      name: '1on1',
      path: '.agents/skills/1on1/SKILL.md',
      installed: true,
      hosts: ['agents'],
      origin: {
        source: '/Users/x/.claude/plugins/cache/inkeep-team-skills/eng/1.2.709/skills/1on1',
        skill: '1on1',
        autoUpdate: false,
      },
    } as never);
    expect(hosts).toContain('claude');
    expect(hosts).toContain('agents');
  });

  test('a global copy at a user-only host (antigravity) stays in the cluster', () => {
    // Ordering through the project vocabulary silently dropped it — the
    // settings row then disagreed with the on-disk ~/.gemini/skills copy.
    const hosts = skillClusterHosts({
      scope: 'global',
      name: 'open-knowledge-discovery',
      path: '.agents/skills/open-knowledge-discovery/SKILL.md',
      installed: true,
      hosts: ['agents', 'claude', 'antigravity'],
    } as never);
    expect(hosts).toContain('antigravity');
  });

  test('no double icon when the provider also holds a real copy', () => {
    const hosts = skillClusterHosts({
      scope: 'project',
      name: 'x',
      path: '.claude/skills/x/SKILL.md',
      installed: true,
      hosts: ['claude'],
      plugin: { name: 'p', marketplace: 'm', provider: 'claude' },
    } as never);
    expect(hosts.filter((h) => h === 'claude')).toHaveLength(1);
  });
});
