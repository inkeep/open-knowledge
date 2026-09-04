import type { SkillScope, SkillSearchResult } from '@inkeep/open-knowledge-core';
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { Search } from 'lucide-react';
import { type ComponentProps, useEffect, useState } from 'react';
import { SkillDirectoryGrid } from '@/components/SkillDirectoryGrid';
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
import { useOpenKnowledgeSkills } from '@/hooks/use-openknowledge-skills';
import { usePopularSkills } from '@/hooks/use-popular-skills';
import { searchSkills } from '@/lib/skills-api';

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

export function ExploreSkills({
  scope,
  onNavigate,
}: {
  scope?: SkillScope;
  onNavigate?: () => void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SkillSearchResult[]>([]);
  const [degraded, setDegraded] = useState(false);
  const [state, setState] = useState<'idle' | 'searching' | 'error'>('idle');
  const [sortBy, setSortBy] = useState<'relevance' | 'installs'>('installs');
  const [showOurs, setShowOurs] = useState(false);
  const { skills: popular } = usePopularSkills();
  const {
    skills: ours,
    isPending: oursPending,
    failed: oursFailed,
  } = useOpenKnowledgeSkills(showOurs);

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

  const shown =
    sortBy === 'installs'
      ? [...results].sort((a, b) => (b.installs ?? -1) - (a.installs ?? -1))
      : results;

  const grid = (props: Omit<ComponentProps<typeof SkillDirectoryGrid>, 'scope' | 'onNavigate'>) => (
    <SkillDirectoryGrid scope={scope} onNavigate={onNavigate} {...props} />
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
            onChange={(e) => {
              setQuery(e.target.value);
              setShowOurs(false);
            }}
            placeholder={t`Search skills`}
            aria-label={t`Search skills`}
          />
        </InputGroup>
        {}
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
      {}
      {/* biome-ignore lint/a11y/useSemanticElements: a filter-chip row is a
          button cluster, not a form-control set; <fieldset>/<legend> would impose
          form chrome. role="group" on a div is the shape the rest of the app uses. */}
      <div
        role="group"
        aria-label={t`Filter skills`}
        className="flex shrink-0 gap-2 overflow-x-auto scroll-fade-mask-x [scrollbar-width:none]"
      >
        <Button
          variant={showOurs ? 'secondary' : 'outline'}
          size="sm"
          aria-pressed={showOurs}
          className="h-6 shrink-0 rounded-full data-[active=true]:border-foreground/30"
          data-active={showOurs}
          onClick={() => {
            setShowOurs((on) => !on);
            setQuery('');
          }}
        >
          <Trans>OpenKnowledge</Trans>
        </Button>
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
              onClick={() => {
                setShowOurs(false);
                setQuery(
                  (active
                    ? tokens.filter((x) => x !== topic.query)
                    : [...tokens, topic.query]
                  ).join(' '),
                );
              }}
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
        {showOurs ? (
          oursFailed ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Couldn't load the OpenKnowledge skills. Try again.</Trans>
            </p>
          ) : (
            grid({
              results: ours,
              pending: oursPending,
              label: <Trans>OpenKnowledge</Trans>,
              loadingLabel: t`Loading OpenKnowledge skills`,
              testId: 'skills-openknowledge',
            })
          )
        ) : q.length < 2 ? (
          popular.length > 0 ? (
            grid({
              results: popular,
              label: <Trans>Popular</Trans>,
              loadingLabel: t`Loading popular skills`,
            })
          ) : null
        ) : state === 'error' ? (
          <p className="text-sm text-destructive">
            <Trans>Search failed. Try again.</Trans>
          </p>
        ) : state === 'idle' && results.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <Trans>No skills found.</Trans>
          </p>
        ) : (
          grid({
            results: shown,
            pending: state === 'searching',
            loadingLabel: t`Searching`,
          })
        )}
      </div>
      {}
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
