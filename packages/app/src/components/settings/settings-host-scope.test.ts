import { describe, expect, test } from 'vitest';
import { scopeSettingsGroupsForHost } from './settings-host-scope';
import type { SidebarGroup } from './settings-sidebar-types';

function groups(): SidebarGroup[] {
  return [
    {
      id: 'agents',
      label: 'Agents',
      enabled: true,
      items: [{ id: 'agent-connections', label: 'Agent connections' }],
    },
    {
      id: 'user',
      label: 'User',
      enabled: true,
      items: [
        { id: 'preferences', label: 'Preferences', userScope: true },
        { id: 'account', label: 'Git' },
      ],
    },
    {
      id: 'integrations',
      label: 'Integrations',
      enabled: true,
      userScope: true,
      items: [{ id: 'about', label: 'About' }],
    },
    {
      id: 'plugins',
      label: 'Plugins',
      enabled: true,
      hideOutsideProject: true,
      items: [{ id: 'plugin:theme', label: 'Themes' }],
    },
  ];
}

function byId(scoped: SidebarGroup[], id: SidebarGroup['id']): SidebarGroup | undefined {
  return scoped.find((group) => group.id === id);
}

describe('scopeSettingsGroupsForHost', () => {
  test('the project host keeps every group as declared', () => {
    expect(scopeSettingsGroupsForHost(groups(), 'project')).toEqual(groups());
  });

  test('the navigator host enables only user-scope panes and hides project-only groups', () => {
    const scoped = scopeSettingsGroupsForHost(groups(), 'navigator');

    expect(byId(scoped, 'plugins')).toBeUndefined();
    expect(byId(scoped, 'agents')).toMatchObject({
      enabled: false,
      items: [{ id: 'agent-connections', disabled: true }],
    });
    expect(byId(scoped, 'user')).toMatchObject({
      enabled: true,
      items: [
        { id: 'preferences', disabled: false },
        { id: 'account', disabled: true },
      ],
    });
  });

  test('a group declared user-scope is enabled in the navigator with all of its items', () => {
    const scoped = scopeSettingsGroupsForHost(groups(), 'navigator');

    expect(byId(scoped, 'integrations')).toMatchObject({
      enabled: true,
      items: [{ id: 'about', disabled: false }],
    });
  });
});
