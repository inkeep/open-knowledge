import type { SkillScope } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { toast } from 'sonner';
import { useOpenSkill } from '@/hooks/use-open-skill';
import { useSkills } from '@/hooks/use-skills';
import { skillNameSetsByScope } from '@/lib/skill-scope';
import { listSkills, saveSkill } from '@/lib/skills-api';

export const DEFAULT_NEW_SKILL_DESCRIPTION = 'Describe what this skill does and when to use it.';

export function useCreateBlankSkill() {
  const { t } = useLingui();
  const skillsState = useSkills();
  const openSkill = useOpenSkill();
  const [creating, setCreating] = useState(false);

  async function createBlank(
    scope: SkillScope = 'project',
    opts?: { name?: string; description?: string },
  ) {
    if (creating) return;
    let name = opts?.name?.trim() || 'new-skill';
    setCreating(true);
    if (!opts?.name) {
      let taken = skillNameSetsByScope(skillsState.status === 'ready' ? skillsState.data : [])[
        scope
      ];
      if (skillsState.status !== 'ready') {
        const listed = await listSkills(scope);
        if (!listed.ok) {
          setCreating(false);
          toast.error(t`Couldn't create skill: ${listed.error}`);
          return;
        }
        taken = skillNameSetsByScope(listed.skills)[scope];
      }
      for (let i = 2; taken.has(name); i++) name = `new-skill-${i}`;
    }
    const description = opts?.description?.trim() || DEFAULT_NEW_SKILL_DESCRIPTION;
    const result = await saveSkill({
      scope,
      name,
      frontmatter: { name, description },
      body: '',
    });
    setCreating(false);
    if (!result.ok) {
      toast.error(t`Couldn't create skill: ${result.error}`);
      return;
    }
    toast.success(t`Skill "${name}" created`);
    openSkill(scope, name, result.path !== undefined ? { path: result.path } : undefined);
  }

  return { createBlank, creating };
}
