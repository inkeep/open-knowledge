/**
 * Descriptor icon resolution — string name → lucide-react component.
 *
 * Named imports (not namespace import) so Vite's tree-shaking only ships the
 * icons actually referenced — a namespace import would bundle all ~1800
 * lucide icons and blow the bundle-size gate. New icons require adding both
 * the import below and the map entry; the registry stays React-free
 * (`packages/core/`) by carrying icons as strings.
 *
 * Shared by the slash menu and the empty-state placeholder so a single map
 * decides which icon renders for a given descriptor — adding an icon for one
 * call site automatically lights up the other.
 */
import {
  AlignCenter,
  AppWindow,
  Box,
  ChevronRight,
  CopyPlus,
  FileText,
  Film,
  GitBranch,
  Image,
  LayoutPanelTop,
  type LucideIcon,
  MessageSquareWarning,
  PanelTop,
  Paperclip,
  PenTool,
  Sigma,
  SquarePlay,
  Volume2,
  Workflow,
  ZoomIn,
} from 'lucide-react';

const ICON_COMPONENTS: Record<string, LucideIcon> = {
  AlignCenter,
  AppWindow,
  ChevronRight,
  CopyPlus,
  FileText,
  Film,
  GitBranch,
  Image,
  LayoutPanelTop,
  MessageSquareWarning,
  PanelTop,
  Paperclip,
  PenTool,
  Sigma,
  SquarePlay,
  Volume2,
  Workflow,
  ZoomIn,
};

/**
 * Whether a descriptor icon name has an explicit `ICON_COMPONENTS` entry.
 * Distinct from `resolveIcon` returning the fallback — the fallback
 * component could legitimately be mapped by name, so identity comparison
 * against it can't detect a missing mapping.
 */
export function hasIconMapping(iconName: string): boolean {
  return Object.hasOwn(ICON_COMPONENTS, iconName);
}

/**
 * Resolve a descriptor icon name (e.g., `'MessageSquareWarning'`) to its
 * lucide-react component. Falls back to `Box` for unknown names or
 * descriptors without an icon (wildcard).
 */
export function resolveIcon(iconName: string | undefined): LucideIcon {
  if (!iconName) return Box;
  // `Object.hasOwn` matches the pattern used by sibling icon resolvers
  // (`Callout.tsx`, `Accordion.tsx`) — those receive user-authored
  // `lucide:*` strings where prototype pollution is a real concern. This
  // resolver receives developer constants from `built-ins.ts`, so the
  // threat model is narrower, but the consistency keeps a single guard
  // pattern across all three call sites.
  return Object.hasOwn(ICON_COMPONENTS, iconName) ? ICON_COMPONENTS[iconName] : Box;
}
