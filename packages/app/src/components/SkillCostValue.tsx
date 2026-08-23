import {
  ALWAYS_ON_TOKEN_BUDGET,
  ON_TRIGGER_TOKEN_BUDGET,
  type SkillCostTiers,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertTriangle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * `chars / 4` estimates read `N` up to a thousand and `N.Nk` beyond. Rounded
 * plainly — the row's job is ranking skills against each other, and an
 * approximation marker on every figure read as noise rather than honesty.
 */
export function formatSkillTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${Math.round(tokens / 100) / 10}k`;
}

/**
 * One tier's figure. Over its published budget it is marked with colour AND an
 * icon carrying the reason, so the warning never rests on colour alone. A tier
 * with no published norm passes no budget and is never marked.
 */
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
  // The bare triangle was uninterpretable in usability testing ("what is that
  // supposed to indicate?") — say what the mark means and what to do about it.
  // Own provider so the figure renders anywhere (settings rows, previews,
  // bare test mounts) without depending on the app-shell TooltipProvider.
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

/**
 * A skill's context cost, one tier per line so the figures column-scan:
 * description (frontmatter, the standing index cost every turn), SKILL.md (the
 * body loaded when the skill fires), other (bundled files, read only when
 * opened), and the total. `SKILL.md` is a filename, not copy — never
 * translated. The surrounding row's label carries the unit.
 */
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
