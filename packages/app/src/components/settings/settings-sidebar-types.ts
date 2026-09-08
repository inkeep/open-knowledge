export interface SidebarSubsection {
  id: string;
  label: string;
  anchor: string;
}

export interface SidebarItem {
  id: string;
  label: string;
  subsections?: SidebarSubsection[];
  keywords?: string[];
}

export interface SidebarGroup {
  id: 'agents' | 'user' | 'project' | 'plugins' | 'integrations';
  label: string;
  enabled: boolean;
  items: SidebarItem[];
}
