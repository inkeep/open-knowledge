import {
  ALWAYS_ON_TOKEN_BUDGET,
  ON_TRIGGER_TOKEN_BUDGET,
  type SkillCostTiers,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertTriangle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export function formatSkillTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${Math.round(tokens / 100) / 10}k`;
}

function TokenFigure({ tokens, budget }: { tokens: number; budget?: number }) {
  const { t } = useLingui();
  const over = budget !== undefined && tokens > budget;
  const budgetLabel = budget !== undefined ? formatSkillTokens(budget) : '';
  const figure = (
    <span
      data-over-budget={over || undefined}
      className={over ? 'text-amber-600 dark:text-amber-500' : undefined}
    >
      {formatSkillTokens(tokens)}
      {over ? (
        <span role="img" aria-label={t`over the ${budgetLabel} token budget`}>
          <AlertTriangle className="ms-0.5 inline size-3 align-[-0.1em]" aria-hidden="true" />
        </span>
      ) : null}
    </span>
  );
  if (!over) return figure;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{figure}</TooltipTrigger>
        <TooltipContent side="right" className="max-w-xs">
          {t`Over the ${budgetLabel} token guidance. Everything here loads into the agent's context when the skill is used — keep it lean, or move detail into references/ files that load only on demand.`}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function SkillCostValue({ size }: { size: SkillCostTiers }) {
  const total = size.alwaysOn + size.onTrigger + size.onDemand;
  return (
    <span
      data-testid="skill-cost-value"
      className="flex flex-col gap-0.5 font-mono text-[13px] text-muted-foreground"
    >
      <span>
        <TokenFigure tokens={size.alwaysOn} budget={ALWAYS_ON_TOKEN_BUDGET} />{' '}
        <Trans comment="The skill's frontmatter description — the always-loaded tier">
          description
        </Trans>
      </span>
      <span>
        <TokenFigure tokens={size.onTrigger} budget={ON_TRIGGER_TOKEN_BUDGET} /> SKILL.md
      </span>
      <span>
        <TokenFigure tokens={size.onDemand} />{' '}
        <Trans comment="Bundled non-SKILL.md files — read only when opened">other</Trans>
      </span>
      <span className="text-foreground/80">
        <TokenFigure tokens={total} /> <Trans comment="Sum of all three token tiers">total</Trans>
      </span>
    </span>
  );
}
