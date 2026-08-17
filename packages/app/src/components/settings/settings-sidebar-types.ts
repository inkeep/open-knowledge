/**
 * Sidebar group/item shape for the Settings dialog. Lifted out of
 * `SettingsDialogShell` so the pure settings-search index can consume the same
 * `groups` the sidebar renders (its enablement gates are the single source of
 * "which sections are reachable") without importing the Shell — which would
 * create a cycle.
 */

/**
 * A named block stacked inside a section's page (e.g. Attachments inside
 * This project → Preferences). Not a sidebar row — subsections exist so the
 * settings search can still find a merged former section by name and land on
 * the exact block via its `anchor`.
 */
export interface SidebarSubsection {
  id: string;
  label: string;
  /**
   * `data-field` value on the subsection's root (or primary control). Search
   * navigation scrolls to and flashes this node, same mechanism as schema
   * fields.
   */
  anchor: string;
}

export interface SidebarItem {
  id: string;
  label: string;
  /**
   * Blocks stacked inside this section's page. Declared next to the item so
   * per-host gates (file:// renderer, pty capability) apply to the search
   * index the same way item-level gates do.
   */
  subsections?: SidebarSubsection[];
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
