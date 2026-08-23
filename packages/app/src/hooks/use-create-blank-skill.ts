import type { SkillScope } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { toast } from 'sonner';
import { useOpenSkill } from '@/hooks/use-open-skill';
import { useSkills } from '@/hooks/use-skills';
import { skillNameSetsByScope } from '@/lib/skill-scope';
import { listSkills, saveSkill } from '@/lib/skills-api';

/**
 * Placeholder description seeded into a freshly-created skill. A skill must have
 * a non-empty `description` to install (the on-disk validation rejects empty),
 * so a blank create that left it empty errored on the very next Install action
 *. The default is intentionally a fill-me-in prompt, not real prose.
 */
export const DEFAULT_NEW_SKILL_DESCRIPTION = 'Describe what this skill does and when to use it.';

/**
 * Shared "start a skill" action — writes a project-scope skill under the given
 * name (defaulting to the first free `new-skill[-N]`) and opens it in the live
 * editor (scope/name/description are then just frontmatter edits). `description`
 * defaults to {@link DEFAULT_NEW_SKILL_DESCRIPTION} so the result is immediately
 * installable. Callers that collect a name/description up front (the New-skill
 * dialog) pass them through; the fast paths (Cmd+K, the hub "New" card) omit
 * them and take the defaults.
 */
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
      // The auto-name loop is only sound against a KNOWN name set, and
      // `PUT /api/skill` is an UPSERT: it overwrites an existing skill's body
      // and frontmatter without complaint (`created: false`, no warning). So an
      // unresolved list is not a harmless "assume nothing is taken" — it means
      // picking `new-skill` regardless of what is there and silently replacing a
      // real skill's contents with the blank template, under a toast that says
      // "created". The list is served from cache and settles fast, but the
      // window is exactly the one a user clicks in: right after opening the app.
      //
      // So when the hook's list is not ready, ask the server before naming
      // rather than guessing. A failure here refuses to create, which is the
      // only safe direction — there is no name we can prove is free.
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
    // Same success toast as the New-skill form (`NewSkillDialog`) so both create
    // paths read identically.
    toast.success(t`Skill "${name}" created`);
    openSkill(scope, name, result.path !== undefined ? { path: result.path } : undefined);
  }

  return { createBlank, creating };
}
