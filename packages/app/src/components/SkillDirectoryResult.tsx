import type {
  SkillCostTiers,
  SkillSearchResult,
  SkillsListEntry,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check, Package } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatSkillTokens } from '@/components/SkillCostValue';
import { SkillDirectoryCard } from '@/components/SkillDirectoryCard';
import { Badge } from '@/components/ui/badge';
import { formatInstalls } from '@/lib/format-installs';
import { peekSkillCardCost, resolveSkillCardCost } from '@/lib/skill-card-cost';

function PublisherAvatar({ login }: { login: string | null }) {
  const [ok, setOk] = useState(true);
  if (login && ok) {
    return (
      <img
        src={`https://github.com/${encodeURIComponent(login)}.png?size=96`}
        alt=""
        loading="lazy"
        className="size-10 rounded border border-border bg-background object-cover"
        onError={() => setOk(false)}
      />
    );
  }
  return (
    <div className="flex size-10 items-center justify-center rounded border border-border bg-muted text-muted-foreground">
      <Package className="size-5" aria-hidden />
    </div>
  );
}

export function SkillDirectoryResult({
  result,
  imported,
  onOpen,
}: {
  readonly result: SkillSearchResult;
  readonly imported: SkillsListEntry | null;
  readonly onOpen: () => void;
}) {
  const { i18n } = useLingui();
  const [cost, setCost] = useState<SkillCostTiers | null>(
    () => peekSkillCardCost(result.source, result.name) ?? null,
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onHover = () => {
    if (peekSkillCardCost(result.source, result.name) !== undefined) return;
    void resolveSkillCardCost(result.source, result.name).then((tiers) => {
      if (mounted.current) setCost(tiers);
    });
  };

  return (
    <SkillDirectoryCard
      name={result.name}
      description={result.description}
      onOpen={onOpen}
      onHover={onHover}
      leading={<PublisherAvatar login={result.publisher} />}
      action={
        imported ? (
          <Badge variant="primary" className="gap-1">
            <Check aria-hidden />
            <Trans>Added</Trans>
          </Badge>
        ) : null
      }
      meta={
        <div className="mt-0.5 flex items-center gap-1.5 text-muted-foreground text-xs">
          <span className="truncate">{result.publisher ?? result.source}</span>
          {}
          {result.publisher === 'openknowledge' || result.publisher === 'inkeep' ? (
            <Badge variant="secondary" className="h-4 px-1 text-[10px] uppercase tracking-wide">
              <Trans>By OpenKnowledge</Trans>
            </Badge>
          ) : null}
          {result.installs != null ? (
            <>
              <span aria-hidden>·</span>
              {}
              <span className="shrink-0">
                <span aria-hidden="true">↓ </span>
                <span className="sr-only">
                  <Trans>installs:</Trans>{' '}
                </span>
                {formatInstalls(result.installs, i18n.locale)}
              </span>
            </>
          ) : null}
          {}
          {cost ? (
            <>
              <span aria-hidden>·</span>
              <span className="shrink-0 whitespace-nowrap" data-testid="skill-card-always-on">
                {formatSkillTokens(cost.alwaysOn)}{' '}
                <Trans comment="Suffix on a skill directory card's context-cost figure — the always-loaded description tier">
                  description tokens
                </Trans>
              </span>
            </>
          ) : null}
        </div>
      }
    />
  );
}
