export interface SidebarSubsection {
  id: string;
  label: string;
  keywords?: string[];
  anchor: string;
}

export interface SidebarItem {
  id: string;
  label: string;
  subsections?: SidebarSubsection[];
  keywords?: string[];
  userScope?: boolean;
  disabled?: boolean;
}

export interface SidebarGroup {
  id: 'agents' | 'user' | 'project' | 'plugins' | 'integrations' | 'app';
  label: string;
  enabled: boolean;
  items: SidebarItem[];
  userScope?: boolean;
  hideOutsideProject?: boolean;
  disabledHint?: string;
}
