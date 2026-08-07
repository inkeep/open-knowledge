import type { SkillSearchResult } from '@inkeep/open-knowledge-core';
import { OPENKNOWLEDGE_SKILLS_REPO } from '@inkeep/open-knowledge-core';
import { useQuery } from '@tanstack/react-query';
import { discoverSkillsInSource, fetchPublisherSkills } from '@/lib/skills-api';

/**
 * The skills OK itself publishes, most-installed first, shaped as discovery
 * results so they render through the same card as any skills.sh row.
 *
 * Two sources, because neither alone is enough. The repository enumeration is
 * the authority on WHAT we publish — it is what we ship today, with
 * descriptions, and none of the retired listings skills.sh still carries — but
 * it knows nothing about installs. The publisher page carries the counts. So
 * the repo supplies the list and the page ranks it, and a skill the page
 * doesn't mention keeps its place at the end rather than disappearing.
 *
 * The ranking half is best-effort by construction: if it fails, the list still
 * renders, just in repository order. The list half is not — no list, nothing to
 * show, which is what `failed` reports.
 *
 * Return shape mirrors {@link usePopularSkills} so a surface can swap one list
 * for the other without reshaping anything. `enabled: false` leaves `isPending`
 * true (nothing has resolved), so only read it on a surface showing this list.
 */
export function useOpenKnowledgeSkills(enabled = true): {
  readonly skills: readonly SkillSearchResult[];
  readonly isPending: boolean;
  readonly failed: boolean;
} {
  const { data, isPending, isError } = useQuery({
    queryKey: ['skills', 'openknowledge'],
    enabled,
    // Our published set moves on release cadence, and each run shallow-clones
    // the repo. Matches the sibling catalog reads.
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<SkillSearchResult[]> => {
      const [listed, ranked] = await Promise.all([
        discoverSkillsInSource(OPENKNOWLEDGE_SKILLS_REPO),
        fetchPublisherSkills(OPENKNOWLEDGE_SKILLS_REPO),
      ]);
      // `getJson` folds network and non-2xx failures into `ok: false`; rethrowing
      // is what turns them into react-query's error state.
      if (!listed.ok) throw new Error(listed.error);
      const installsByName = new Map(
        (ranked.ok ? ranked.results : []).map((r) => [r.name, r.installs]),
      );
      return (listed.skills ?? [])
        .map((s) => ({
          id: `${OPENKNOWLEDGE_SKILLS_REPO}/${s.name}`,
          name: s.name,
          source: OPENKNOWLEDGE_SKILLS_REPO,
          description: s.description ?? '',
          installs: installsByName.get(s.name) ?? null,
          publisher: OPENKNOWLEDGE_SKILLS_REPO.split('/')[0] ?? null,
        }))
        .sort((a, b) => (b.installs ?? -1) - (a.installs ?? -1));
    },
  });

  return { skills: data ?? [], isPending, failed: isError };
}
