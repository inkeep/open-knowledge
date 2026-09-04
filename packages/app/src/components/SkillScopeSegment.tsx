import type { SkillScope } from '@inkeep/open-knowledge-core';
import { Trans } from '@lingui/react/macro';
import { useId } from 'react';
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';

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
