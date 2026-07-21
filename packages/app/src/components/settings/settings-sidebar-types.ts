/**
 * Sidebar group/item shape for the Settings dialog. Lifted out of
 * `SettingsDialogShell` so the pure settings-search index can consume the same
 * `groups` the sidebar renders (its enablement gates are the single source of
 * "which sections are reachable") without importing the Shell — which would
 * create a cycle.
 */

export interface SidebarItem {
  id: string;
  label: string;
}

export interface SidebarGroup {
  id: 'user' | 'project' | 'plugins' | 'integrations';
  label: string;
  /**
   * `false` renders the group disabled (no-project state for THIS
   * PROJECT). Items are visible but not focusable; group label gets
   * an explanatory caption announced via aria-describedby.
   */
  enabled: boolean;
  items: SidebarItem[];
}
