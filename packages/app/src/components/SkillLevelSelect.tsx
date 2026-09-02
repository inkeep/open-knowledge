import type { SkillScope } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SKILL_SCOPE_ORDER, useSkillScopeLabels } from '@/lib/skill-scope';
import { cn } from '@/lib/utils';

export function SkillLevelSelect({
  value,
  onRequestMove,
  disabled,
  triggerClassName,
}: {
  value: SkillScope;
  onRequestMove: (next: SkillScope) => void;
  disabled?: boolean;
  triggerClassName?: string;
}) {
  const { t } = useLingui();
  const scopeLabels = useSkillScopeLabels();
  return (
    <Select value={value} onValueChange={(v) => onRequestMove(v as SkillScope)} disabled={disabled}>
      <SelectTrigger
        size="sm"
        aria-label={t`Level`}
        data-testid="skill-level-select"
        className={cn('w-auto gap-1 text-xs font-mono uppercase', triggerClassName)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectGroup>
          <SelectLabel>
            <Trans>Level</Trans>
          </SelectLabel>
          {SKILL_SCOPE_ORDER.map((s) => (
            <SelectItem key={s} value={s}>
              {scopeLabels[s]}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
