export interface SidebarSubsection {
  id: string;
  label: string;
  anchor: string;
}

export interface SidebarItem {
  id: string;
  label: string;
  subsections?: SidebarSubsection[];
}

export interface SidebarGroup {
  id: 'user' | 'project' | 'plugins' | 'integrations';
  label: string;
  enabled: boolean;
  items: SidebarItem[];
}
