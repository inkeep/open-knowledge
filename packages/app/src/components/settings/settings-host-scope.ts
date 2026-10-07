import type { SidebarGroup, SidebarItem } from './settings-sidebar-types';

export type SettingsHost = 'project' | 'navigator';

export function scopeSettingsGroupsForHost(
  groups: readonly SidebarGroup[],
  host: SettingsHost,
): SidebarGroup[] {
  if (host === 'project') return [...groups];
  return groups
    .filter((group) => group.hideOutsideProject !== true)
    .map((group) => {
      const items = group.items.map((item) => ({
        ...item,
        disabled: item.disabled === true || !(group.userScope === true || item.userScope === true),
      }));
      return {
        ...group,
        enabled: group.enabled && items.some((item) => !item.disabled),
        items,
      };
    });
}

export function isSidebarItemSelectable(group: SidebarGroup, item: SidebarItem): boolean {
  return group.enabled && item.disabled !== true;
}
