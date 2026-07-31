import type { SkillSearchResult, SkillsListEntry } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Check, Package } from 'lucide-react';
import { useState } from 'react';
import { SkillDirectoryCard } from '@/components/SkillDirectoryCard';
import { Badge } from '@/components/ui/badge';
import { formatInstalls } from '@/lib/format-installs';

// The `publisher` is a GitHub owner login, so `github.com/<login>.png` yields its
// avatar with no API call. Rendered as the card's leading logo; decorative
// (`alt=""`) since the publisher name renders as text alongside it. Falls back to
// a neutral tile when there's no login or the image 404s (deleted org, non-GitHub
// source), so the row never shows a broken-image glyph.
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

/**
 * One skills.sh directory row, shared by every surface that lists discovery
 * results — the Explore modal's search + popular grids and the Skills home's
 * popular grid — so a card reads identically wherever it appears.
 *
 * Row layout: the publisher's avatar leads, then a `name` + `publisher · ↓
 * installs` column, then — only once a skill is already in OK — an "Added" badge.
 * The whole card is a stretched link into the preview, which is the single
 * per-card action and where Install lives (no inline `+`).
 */
export function SkillDirectoryResult({
  result,
  imported,
  onOpen,
}: {
  readonly result: SkillSearchResult;
  /** The already-imported project skill for this result, or null. Drives the
   *  "Added" badge; resolving it is the caller's job (`useSkillDirectory`). */
  readonly imported: SkillsListEntry | null;
  readonly onOpen: () => void;
}) {
  const { i18n } = useLingui();
  return (
    <SkillDirectoryCard
      name={result.name}
      description={result.description}
      onOpen={onOpen}
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
          {/* First-party mark: a publisher-field fact — never a capability
              claim, just who publishes. */}
          {result.publisher === 'openknowledge' || result.publisher === 'inkeep' ? (
            <Badge variant="secondary" className="h-4 px-1 text-[10px] uppercase tracking-wide">
              <Trans>By OpenKnowledge</Trans>
            </Badge>
          ) : null}
          {result.installs != null ? (
            <>
              <span aria-hidden>·</span>
              {/* The arrow is decoration — a screen reader announcing "down arrow
                  2.7M" conveys nothing — so hide it and name the number instead. */}
              <span className="shrink-0">
                <span aria-hidden="true">↓ </span>
                <span className="sr-only">
                  <Trans>installs:</Trans>{' '}
                </span>
                {formatInstalls(result.installs, i18n.locale)}
              </span>
            </>
          ) : null}
        </div>
      }
    />
  );
}
