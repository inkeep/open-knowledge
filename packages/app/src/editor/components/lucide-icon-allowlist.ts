/**
 * Shared lucide-icon allowlist for descriptor `icon` props.
 *
 * Single source of truth consumed by:
 *   - Component renderers (`Callout`, `Accordion`) — used as the
 *     `ICON_OVERRIDES` map so a `lucide:Foo` value resolves to the same
 *     component everywhere.
 *   - The PropPanel `IconPickerInput` — populates the picker grid so
 *     authors can only choose names that the renderers actually resolve.
 *
 * Why a shared allowlist (vs `lucide-react/dynamicIconImports` for the
 * full set): each entry is a static named import, so Vite tree-shakes
 * unused icons out of the bundle. Dynamic imports would either ship the
 * entire library or code-split per-icon — neither acceptable for an
 * editor surface that mounts on every doc.
 *
 * Extending is additive: add the named import + the registry entry.
 * `Object.hasOwn` guards every lookup against prototype-pollution names
 * (`__proto__`, `constructor`, `toString`) which would otherwise return
 * truthy non-component values and crash the renderer — co-editor DoS
 * vector.
 */
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

/**
 * Curated allowlist of lucide icons available via `icon="lucide:<Name>"`
 * on descriptor `icon` props. Keys are the lucide export name (the same
 * string the picker writes after the `lucide:` prefix). Order doesn't
 * matter at the consumer level — the picker sorts alphabetically.
 *
 * The 15 baseline icons cover Callout's 5 GFM-type defaults + 10
 * Obsidian-parity additions. `ChevronRight` is added as the standard
 * disclosure affordance (Accordion's default), so it appears in the
 * picker without needing a separate "Accordion-only" branch.
 */
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

/**
 * Sorted list of (name, Component) tuples — feed to a picker grid that
 * needs deterministic ordering for tests + screen-reader DOM order.
 */
export const LUCIDE_ICON_ENTRIES: ReadonlyArray<readonly [string, LucideIcon]> = Object.entries(
  LUCIDE_ICON_ALLOWLIST,
).sort(([a], [b]) => a.localeCompare(b));

/**
 * Resolve a `lucide:<Name>` identifier against the allowlist. Returns
 * `null` for absent values, non-`lucide:` prefixes, or unknown names —
 * the renderer decides what to do with `null` (fall back to a default,
 * render an emoji span, etc.).
 */
export function resolveLucideIcon(icon: string | undefined): LucideIcon | null {
  if (!icon) return null;
  if (!icon.startsWith('lucide:')) return null;
  const name = icon.slice('lucide:'.length);
  return Object.hasOwn(LUCIDE_ICON_ALLOWLIST, name) ? (LUCIDE_ICON_ALLOWLIST[name] ?? null) : null;
}
