import {
  ALWAYS_ON_TOKEN_BUDGET,
  ON_TRIGGER_TOKEN_BUDGET,
  type SkillCostTiers,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { AlertTriangle } from 'lucide-react';

/**
 * `chars / 4` estimates read `~N` up to a thousand and `~N.Nk` beyond, so a
 * heavy body stays legible in a dense row. The `~` disclaims the precision a
 * real tokenizer would give.
 */
export function formatSkillTokens(tokens: number): string {
  if (tokens < 1000) return `~${tokens}`;
  return `~${Math.round(tokens / 100) / 10}k`;
}

/**
 * One tier's figure. Over its published budget it is marked with colour AND an
 * icon carrying the reason, so the warning never rests on colour alone. A tier
 * with no published norm (on-demand) passes no budget and is never marked.
 */
function TokenFigure({ tokens, budget }: { tokens: number; budget?: number }) {
  const { t } = useLingui();
  const over = budget !== undefined && tokens > budget;
  const budgetLabel = budget !== undefined ? formatSkillTokens(budget) : '';
  return (
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
}

/**
 * A skill's context cost as a single inline value: always-on (its standing index
 * cost), on-trigger (the body loaded when it fires) and on-demand (readable
 * references, loaded only when opened). Never a summed figure — the three tiers
 * are paid at different times and a total misranks skills. The surrounding row's
 * label carries the unit, so the figures stay bare but for the `~` estimate
 * marker.
 *
 * `omitOnDemand` drops the on-demand tier for the compact install-row subset
 * (always-on + on-trigger only) — omission, not summation. On-demand's full
 * figure still shows in the preview and the confirm modal.
 */
export function SkillCostValue({
  size,
  omitOnDemand,
}: {
  size: SkillCostTiers;
  omitOnDemand?: boolean;
}) {
  return (
    <span data-testid="skill-cost-value" className="font-mono text-[13px] text-muted-foreground">
      <TokenFigure tokens={size.alwaysOn} budget={ALWAYS_ON_TOKEN_BUDGET} />{' '}
      <Trans>always-on</Trans>
      {' · '}
      <TokenFigure tokens={size.onTrigger} budget={ON_TRIGGER_TOKEN_BUDGET} />{' '}
      <Trans>on trigger</Trans>
      {omitOnDemand ? null : (
        <>
          {' · '}
          <TokenFigure tokens={size.onDemand} /> <Trans>on demand</Trans>
        </>
      )}
    </span>
  );
}
