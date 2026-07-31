import type { SkillScope, SkillSearchResult } from '@inkeep/open-knowledge-core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SkillDirectoryResult } from '@/components/SkillDirectoryResult';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { usePopularSkills } from '@/hooks/use-popular-skills';
import { useSkillDirectory } from '@/hooks/use-skill-directory';
import { searchSkills } from '@/lib/skills-api';

// Stable keys for the fixed skeleton set (avoids array-index keys). Sized to
// roughly fill the visible grid so the searching state holds the dialog's height
// instead of collapsing from the taller popular/results grids.
const SKELETON_KEYS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];

// Suggested topics for the default (pre-search) state. skills.sh has no
// trending endpoint and rejects empty queries, so instead of a blank screen we
// offer one-click searches. Each chip just seeds the search box.
const TOPICS: ReadonlyArray<{ label: ReturnType<typeof msg>; query: string }> = [
  { label: msg`Design`, query: 'design' },
  { label: msg`Git & PRs`, query: 'git' },
  { label: msg`Testing`, query: 'test' },
  { label: msg`Agents`, query: 'agent' },
  { label: msg`React`, query: 'react' },
  { label: msg`Docs`, query: 'docs' },
  { label: msg`Refactoring`, query: 'refactor' },
  { label: msg`Data`, query: 'data' },
  { label: msg`DevOps`, query: 'devops' },
  { label: msg`Security`, query: 'security' },
];

/**
 * Explore tab — discover and preview skills from skills.sh. Clicking a result
 * opens its read-only preview, which is where Install lives; a result already in
 * the project opens its real doc instead. Search runs through `searchSkills` (the
 * keyless proxy, with a degraded GitHub fallback when skills.sh is unreachable)
 * and is debounced; a result's `source` is the skills.sh catalog identifier used
 * for detail routing. Sub-2-char queries show the popular list, or suggested-topic
 * chips when that comes back empty.
 */
export function ExploreSkills({
  scope,
  onNavigate,
}: {
  scope?: SkillScope;
  onNavigate?: () => void;
}) {
  const { t } = useLingui();
  // Already-imported detection + the click destination, shared with the Skills
  // home's popular grid so a card behaves identically on both surfaces.
  const { importedEntry, openResult } = useSkillDirectory({ scope, onNavigate });
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SkillSearchResult[]>([]);
  const [degraded, setDegraded] = useState(false);
  const [state, setState] = useState<'idle' | 'searching' | 'error'>('idle');
  const [sortBy, setSortBy] = useState<'relevance' | 'installs'>('relevance');
  // Popular skills for the blank state, so Discover isn't an empty box before you
  // type. Shared cache with the Skills home's shelf, so opening this modal from
  // that page does not refetch. Best-effort — an empty result (fetch/parse
  // failure) just falls back to the topic chips.
  const { skills: popular } = usePopularSkills();

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setState('idle');
      return;
    }
    let cancelled = false;
    setState('searching');
    const timer = setTimeout(() => {
      void searchSkills(q).then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setState('error');
          setResults([]);
          // Clear the fallback banner: a failed search has no ranking signal, so
          // a stale `degraded: true` from a prior GitHub-fallback hit must not linger.
          setDegraded(false);
          return;
        }
        setResults(res.results);
        setDegraded(res.degraded);
        setState('idle');
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const q = query.trim();

  // Client-side sort over the current results. skills.sh returns relevance
  // order; "Most installed" reorders by install count (nulls — the degraded
  // GitHub fallback carries none — sort last).
  const shown =
    sortBy === 'installs'
      ? [...results].sort((a, b) => (b.installs ?? -1) - (a.installs ?? -1))
      : results;

  // One card renderer shared by the search grid and the blank-state popular grid.
  const renderResult = (r: SkillSearchResult) => (
    <SkillDirectoryResult
      key={r.id}
      result={r}
      imported={importedEntry(r)}
      onOpen={() => openResult(r)}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 items-center gap-2">
        <InputGroup className="h-9 flex-1">
          <InputGroupAddon align="inline-start">
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t`Search skills`}
            aria-label={t`Search skills`}
          />
        </InputGroup>
        {/* Sort sits beside the search, but only once there are results to sort. */}
        {q.length >= 2 && state === 'idle' && results.length > 0 ? (
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as 'relevance' | 'installs')}>
            <SelectTrigger className="h-9! w-40 shrink-0" aria-label={t`Sort skills`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>{t`Sort by`}</SelectLabel>
                <SelectItem value="relevance">{t`Relevance`}</SelectItem>
                <SelectItem value="installs">{t`Most installed`}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : null}
      </div>
      {/* Topic chips are MULTI-SELECT search terms, not one-shot seeds: each
          toggles its word in/out of the search box, so several stack into one
          query (`design git test`). The box stays the single source of truth,
          so typing and chips compose. Active = the word is a token in the box.
          Single line: overflow horizontally with the fade-mask, scrollbar hidden. */}
      <div className="flex shrink-0 gap-2 overflow-x-auto scroll-fade-mask-x [scrollbar-width:none]">
        {TOPICS.map((topic) => {
          const tokens = query.trim().split(/\s+/).filter(Boolean);
          const active = tokens.includes(topic.query);
          return (
            <Button
              key={topic.query}
              variant={active ? 'secondary' : 'outline'}
              size="sm"
              aria-pressed={active}
              className="h-6 shrink-0 rounded-full data-[active=true]:border-foreground/30"
              data-active={active}
              onClick={() =>
                setQuery(
                  (active
                    ? tokens.filter((x) => x !== topic.query)
                    : [...tokens, topic.query]
                  ).join(' '),
                )
              }
            >
              {t(topic.label)}
            </Button>
          );
        })}
      </div>
      {degraded && q.length >= 2 ? (
        <p className="text-[11px] text-muted-foreground">
          <Trans>skills.sh is unavailable; showing GitHub results (no install ranking).</Trans>
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto subtle-scrollbar scroll-fade-mask">
        {q.length < 2 ? (
          // Popular skills populate the blank state (best-effort; empty on a scrape
          // failure, in which case the persistent topic chips above are the fallback).
          popular.length > 0 ? (
            <div className="space-y-2">
              {/* Same element + classes as the Skills home's shelf label, which
                  sits above the same card grid — a user sees both in one session. */}
              <h3 className="font-mono text-2xs uppercase tracking-wider text-muted-foreground">
                <Trans>Popular</Trans>
              </h3>
              <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {popular.map(renderResult)}
              </ul>
            </div>
          ) : null
        ) : state === 'searching' ? (
          <div aria-busy="true">
            <span className="sr-only">
              <Trans>Searching</Trans>
            </span>
            <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2" aria-hidden>
              {SKELETON_KEYS.map((k) => (
                <Skeleton key={k} className="h-[72px] rounded-xl" />
              ))}
            </ul>
          </div>
        ) : state === 'error' ? (
          <p className="text-sm text-destructive">
            <Trans>Search failed. Try again.</Trans>
          </p>
        ) : results.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>No skills found.</Trans>
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">{shown.map(renderResult)}</ul>
        )}
      </div>
      {/* Credit the discovery API — results (and install counts) come from skills.sh.
          The line is bottom-flush (the flex-1 list above pushes it down), so it has
          12px above (`gap-3`) but 24px below (the dialog's `p-6`). `-mb-1.5` bleeds
          it 6px into that bottom padding — same edge-bleed trick as DialogFooter —
          so it reads 18px/18px, vertically centered, with the footer no thicker. */}
      <p className="-mb-3.5 shrink-0 text-center text-[11px] text-muted-foreground/80">
        <Trans>
          Skill discovery powered by{' '}
          <a
            href="https://skills.sh"
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-foreground"
          >
            skills.sh
          </a>
        </Trans>
      </p>
    </div>
  );
}
