import type { SkillsListEntry } from '@inkeep/open-knowledge-core';
import type { ProvenanceBucket } from '@/lib/skill-provenance-bucket';

/**
 * The members of a provenance group that "Update all from this source" can
 * actually re-pull.
 *
 * Pure and separate from the tree component because it is a filter with four
 * independent reasons to exclude a row, and every one of them is a silent
 * wrong-menu bug if it drifts: an action offered on a group whose members
 * cannot update reports failures the user could not have avoided, and an action
 * withheld from one that can is simply missing.
 */
export function groupUpdatableSkills(input: {
  /** `<ScopeLabel>/<GroupId>` for the group row in question. */
  groupPrefix: string;
  bucket: ProvenanceBucket | undefined;
  skillByPrefix: ReadonlyMap<string, SkillsListEntry>;
}): SkillsListEntry[] {
  const { groupPrefix, bucket, skillByPrefix } = input;
  // A harness plugin group is vendor state: its files are replaced when the
  // harness updates the plugin, so re-pulling them from here is not ours to do.
  // A PACK child group (plugin-kind under a repo parent, addressed on
  // skills.sh) is different — its members update through the ordinary reimport
  // path, exactly like the repo parent that holds it.
  const packChild = bucket?.kind === 'plugin' && bucket.parent !== undefined && bucket.url !== null;
  if (!bucket || (bucket.kind === 'plugin' && !packChild)) return [];
  const prefix = `${groupPrefix}/`;
  const members: SkillsListEntry[] = [];
  for (const [rowPrefix, skill] of skillByPrefix) {
    if (!rowPrefix.startsWith(prefix)) continue;
    const source = skill.origin?.source;
    // No recorded source: nothing to update FROM. An `adopt:<harness>` source
    // names a harness rather than a fetchable remote — the original is now a
    // symlink to the local copy, so a re-pull could only error.
    if (!source || source.startsWith('adopt:')) continue;
    members.push(skill);
  }
  return members;
}

/**
 * The members of a provenance group that "Delete N skills" may remove — the
 * group-row bulk delete. Broader than {@link groupUpdatableSkills}: deletion
 * needs no recorded source (an adopted or source-less copy is still ours to
 * remove). Same plugin gate though — a harness plugin's served skills are
 * vendor state OK never mutates — and managed built-ins are read-only
 * everywhere.
 */
export function groupDeletableSkills(input: {
  groupPrefix: string;
  bucket: ProvenanceBucket | undefined;
  skillByPrefix: ReadonlyMap<string, SkillsListEntry>;
}): SkillsListEntry[] {
  const { groupPrefix, bucket, skillByPrefix } = input;
  const packChild = bucket?.kind === 'plugin' && bucket.parent !== undefined && bucket.url !== null;
  if (!bucket || (bucket.kind === 'plugin' && !packChild)) return [];
  const prefix = `${groupPrefix}/`;
  const members: SkillsListEntry[] = [];
  for (const [rowPrefix, skill] of skillByPrefix) {
    if (!rowPrefix.startsWith(prefix)) continue;
    if (skill.managed) continue;
    members.push(skill);
  }
  return members;
}
