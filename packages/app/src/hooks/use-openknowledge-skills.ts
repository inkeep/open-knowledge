import type { SkillSearchResult } from '@inkeep/open-knowledge-core';
import { OPENKNOWLEDGE_SKILLS_REPO } from '@inkeep/open-knowledge-core';
import { useQuery } from '@tanstack/react-query';
import { discoverSkillsInSource, fetchPublisherSkills } from '@/lib/skills-api';

export function useOpenKnowledgeSkills(enabled = true): {
  readonly skills: readonly SkillSearchResult[];
  readonly isPending: boolean;
  readonly failed: boolean;
} {
  const { data, isPending, isError } = useQuery({
    queryKey: ['skills', 'openknowledge'],
    enabled,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<SkillSearchResult[]> => {
      const [listed, ranked] = await Promise.all([
        discoverSkillsInSource(OPENKNOWLEDGE_SKILLS_REPO),
        fetchPublisherSkills(OPENKNOWLEDGE_SKILLS_REPO),
      ]);
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
