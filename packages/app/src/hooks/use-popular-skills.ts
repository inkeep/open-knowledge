import type { SkillSearchResult } from '@inkeep/open-knowledge-core';
import { useQuery } from '@tanstack/react-query';
import { fetchPopularSkills } from '@/lib/skills-api';

/**
 * The skills.sh popular list, shared by every surface that shows it (the Skills
 * home shelf and the Explore modal's blank state). One `useQuery` entry means the
 * two surfaces hit `/api/skills/popular` once between them instead of firing a
 * request each when the modal opens over the home page.
 *
 * `staleTime` matches the other catalog-ish reads in the app (agent catalog, harness
 * detection): the server already caches its scrape, and a popularity ranking that
 * moves over days does not need refetching on every mount.
 *
 * Failure is not surfaced as an error state — every consumer treats "no popular
 * list" the same way it treats an empty one, by hiding the shelf. `failed` is
 * exposed for the caller that wants to distinguish it from a genuinely empty
 * upstream list.
 */
export function usePopularSkills(): {
  readonly skills: readonly SkillSearchResult[];
  readonly isPending: boolean;
  readonly failed: boolean;
} {
  const { data, isPending, isError } = useQuery({
    queryKey: ['skills', 'popular'],
    queryFn: async () => {
      const res = await fetchPopularSkills();
      // `getJson` already folds network and non-2xx failures into `ok: false`, so
      // rethrowing here is what turns them into react-query's error state.
      if (!res.ok) throw new Error(res.error);
      return res.results;
    },
    staleTime: 5 * 60 * 1000,
  });

  return { skills: data ?? [], isPending, failed: isError };
}
