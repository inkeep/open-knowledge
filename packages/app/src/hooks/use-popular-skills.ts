import type { SkillSearchResult } from '@inkeep/open-knowledge-core';
import { useQuery } from '@tanstack/react-query';
import { fetchPopularSkills } from '@/lib/skills-api';

export function usePopularSkills(): {
  readonly skills: readonly SkillSearchResult[];
  readonly isPending: boolean;
  readonly failed: boolean;
} {
  const { data, isPending, isError } = useQuery({
    queryKey: ['skills', 'popular'],
    queryFn: async () => {
      const res = await fetchPopularSkills();
      if (!res.ok) throw new Error(res.error);
      return res.results;
    },
    staleTime: 5 * 60 * 1000,
  });

  return { skills: data ?? [], isPending, failed: isError };
}
