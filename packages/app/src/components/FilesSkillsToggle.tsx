import { useLingui } from '@lingui/react/macro';
import { File, Hexagon, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDocumentContext } from '@/editor/DocumentContext';
import { cn } from '@/lib/utils';

interface FilesSkillsToggleProps {
  /** Which surface is currently active — drives the highlighted segment. */
  active: 'files' | 'skills';
}

/**
 * Persistent Files/Skills switch at the top of the sidebar. Each surface is
 * icon-first: the unselected segment is icon-only, and selecting one unfurls its
 * label (an animated `grid-template-columns` 0fr→1fr width reveal, clipped by
 * `overflow-hidden`) so the active surface is the only one that reads as text.
 * The collapsed segment carries a tooltip so its bare icon can still be named on
 * hover. Both segments stay in the DOM at all times — the collapsed label is
 * clipped, not removed, so it remains in the accessible name. Selecting flips
 * the sidebar surface. A surface with no remembered tab opens its ephemeral home
 * tab; Skills home uses its canonical route so browser history restores the
 * correct surface (see `EditorArea`). The icon-only
 * width is content-sized (no `w-full`) so it can share the sidebar chrome row
 * with the trailing search affordance.
 */
export function FilesSkillsToggle({ active }: FilesSkillsToggleProps) {
  const { t } = useLingui();
  const { setSkillsSidebar } = useDocumentContext();
  return (
    <ToggleGroup
      type="single"
      value={active}
      onValueChange={(value) => {
        // Radix single-select lets you click the active item to clear it; ignore
        // the empty case so one surface is always selected.
        if (value === 'skills') setSkillsSidebar(true);
        else if (value === 'files') setSkillsSidebar(false);
      }}
      aria-label={t`Switch between Files and Skills`}
      size="sm"
      spacing={1}
    >
      <Segment
        value="files"
        icon={File}
        label={t`Files`}
        selected={active === 'files'}
        testId="sidebar-files-toggle"
      />
      <Segment
        value="skills"
        icon={Hexagon}
        label={t`Skills`}
        selected={active === 'skills'}
        testId="sidebar-skills-toggle"
      />
    </ToggleGroup>
  );
}

/**
 * One toggle segment. Icons render at `size-4` with the lucide default stroke so
 * they match the sidebar search icon in size, weight, and (via the shared
 * `text-muted-foreground` unselected color) hue.
 *
 * Two constraints force styling to key off the `selected` prop rather than the
 * item's `data-[state=on]`:
 *
 *  1. The Tooltip wraps the item UNCONDITIONALLY. Gating the wrapper on `selected`
 *     changes the element type at this position, so React would remount the
 *     ToggleGroupItem on every toggle — and a freshly-mounted node renders at its
 *     final width with nothing to transition from, so the unfurl never plays.
 *     A stable tree preserves the DOM node so the width reveal animates.
 *  2. `TooltipTrigger` and `ToggleGroupItem` BOTH write `data-state` to the same
 *     element (open/closed vs on/off); through `asChild` the tooltip's value wins,
 *     so `data-[state=on]:*` styles silently stop matching. Radix still drives
 *     selection via `aria-checked`, so behavior is fine — but the chip background,
 *     selected text color, and label reveal must come from `selected` instead.
 *
 * The selected chip is a quiet `bg-foreground/5` overlay (a touch stronger in
 * dark); `cn` + tailwind-merge make these last-wins overrides deterministic.
 */
function Segment({
  value,
  icon: Icon,
  label,
  selected,
  testId,
}: {
  value: 'files' | 'skills';
  icon: LucideIcon;
  label: string;
  selected: boolean;
  testId: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToggleGroupItem
          value={value}
          // Collapsed, the segment is effectively icon-only (its label is clipped
          // to 0 width), so pin the accessible name explicitly rather than lean on
          // AT reliably traversing grid-clipped text. When selected the visible
          // label is the name (WCAG 2.5.3 Label in Name), so clear the override.
          aria-label={selected ? undefined : label}
          className={cn(
            'gap-0',
            selected && 'bg-foreground/5 text-foreground dark:bg-foreground/10',
          )}
          data-testid={testId}
        >
          <Icon className="size-4" aria-hidden />
          <UnfurlingLabel expanded={selected}>{label}</UnfurlingLabel>
        </ToggleGroupItem>
      </TooltipTrigger>
      {selected ? null : <TooltipContent side="bottom">{label}</TooltipContent>}
    </Tooltip>
  );
}

/**
 * The segment label, revealed only when its segment is selected. The
 * `grid-cols-[0fr]`→`[1fr]` track animates width; `overflow-hidden` both clips the
 * collapsed label and forces the grid child's automatic minimum size to 0 so the
 * track can actually reach 0fr. Keyed off the `expanded` prop (not the item's
 * `data-state`, which the Tooltip clobbers — see `Segment`); toggling the class on
 * this persistent node is what the CSS transition animates. The leading padding
 * sits INSIDE the clipped region so the icon↔label gap collapses with the label,
 * keeping the icon centered when the segment is icon-only.
 */
function UnfurlingLabel({ children, expanded }: { children: ReactNode; expanded: boolean }) {
  return (
    <span
      className={cn(
        'grid grid-cols-[0fr] transition-[grid-template-columns] duration-150 ease-out motion-reduce:transition-none',
        expanded && 'grid-cols-[1fr]',
      )}
    >
      <span className="overflow-hidden">
        <span className="block whitespace-nowrap pl-1.5">{children}</span>
      </span>
    </span>
  );
}
