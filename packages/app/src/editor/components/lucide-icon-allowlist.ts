import {
  AlertOctagon,
  AlertTriangle,
  BookOpen,
  Bug,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  CircleX,
  ClipboardList,
  FlaskConical,
  Info,
  Lightbulb,
  ListTodo,
  type LucideIcon,
  MessageSquareWarning,
  Quote,
  Zap,
} from 'lucide-react';

export const LUCIDE_ICON_ALLOWLIST: Record<string, LucideIcon> = {
  Info,
  Lightbulb,
  MessageSquareWarning,
  AlertTriangle,
  AlertOctagon,
  ClipboardList,
  BookOpen,
  ListTodo,
  CircleCheck,
  CircleHelp,
  CircleX,
  Zap,
  Bug,
  FlaskConical,
  Quote,
  ChevronRight,
};

export const LUCIDE_ICON_ENTRIES: ReadonlyArray<readonly [string, LucideIcon]> = Object.entries(
  LUCIDE_ICON_ALLOWLIST,
).sort(([a], [b]) => a.localeCompare(b));

export function resolveLucideIcon(icon: string | undefined): LucideIcon | null {
  if (!icon) return null;
  if (!icon.startsWith('lucide:')) return null;
  const name = icon.slice('lucide:'.length);
  return Object.hasOwn(LUCIDE_ICON_ALLOWLIST, name) ? (LUCIDE_ICON_ALLOWLIST[name] ?? null) : null;
}
