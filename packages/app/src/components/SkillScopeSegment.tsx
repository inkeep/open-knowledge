import type { SkillScope } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { useId } from 'react';
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';

/**
 * The "where does this skill live" picker for skill menus — a two-segment
 * switch (This project / This machine) with a consequence line that changes
 * with the selection.
 *
 * Replaces the "Level: Project / Global" radio rows, which stacked three
 * confusions: "Level" is product jargon; a selection mark beside a bare word
 * read as state (the checkmark was already once mistaken for "installed");
 * and flipping it silently rewrote the destination paths below with a `~/`
 * prefix nobody noticed. A switch reads as a control, the labels answer the
 * user's actual question, and the consequence line says what changes.
 *
 * Built ON the menu's radio primitives rather than free buttons so the pair
 * stays arrow-key navigable inside the Radix menu (free buttons are outside
 * the menu's roving tabindex and unreachable by keyboard). The indicator dot
 * is hidden — in a segment, the selected state IS the fill.
 */
const SEGMENT_ITEM_CLASS =
  'justify-center rounded-[5px] px-2 text-xs font-medium data-[state=checked]:bg-background data-[state=checked]:text-foreground data-[state=checked]:shadow-sm [&_[data-slot=dropdown-menu-radio-item-indicator]]:hidden';

export function SkillScopeSegment({
  value,
  onSelect,
  disabled,
}: {
  value: SkillScope;
  onSelect: (next: SkillScope) => void;
  disabled?: boolean;
}) {
  // The consequence line is bound to each radio item via aria-describedby:
  // menu-mode screen readers (JAWS/NVDA) follow item focus and do not reliably
  // announce live regions inside role=menu, but they DO read an item's
  // description with the item itself.
  const consequenceId = useId();
  return (
    <>
      <DropdownMenuLabel>
        <Trans>Where</Trans>
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={value}
        onValueChange={(v) => onSelect(v as SkillScope)}
        className="mx-1 grid grid-cols-2 gap-0.5 rounded-md bg-muted/50 p-0.5"
        data-testid="skill-scope-segment"
      >
        <DropdownMenuRadioItem
          value="project"
          disabled={disabled}
          onSelect={(e) => e.preventDefault()}
          aria-describedby={consequenceId}
          className={SEGMENT_ITEM_CLASS}
        >
          <Trans>This project</Trans>
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem
          value="global"
          disabled={disabled}
          onSelect={(e) => e.preventDefault()}
          aria-describedby={consequenceId}
          className={SEGMENT_ITEM_CLASS}
        >
          <Trans>This machine</Trans>
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      <div
        id={consequenceId}
        className="px-2 pt-1 pb-1.5 text-xs leading-snug text-muted-foreground"
        data-testid="skill-scope-consequence"
      >
        {value === 'project' ? (
          <Trans>In this repo — collaborators get copies via git.</Trans>
        ) : (
          <Trans>In your home folder — every project on this machine, just you.</Trans>
        )}
      </div>
    </>
  );
}
