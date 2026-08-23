import type { Config, SkillScope } from '@inkeep/open-knowledge-core';

/**
 * Pinned skills, read out of config and normalized.
 *
 * Pin scope follows SKILL scope, which is the whole reason there are two lists
 * rather than one. Pinning a project skill says "this repo's work"; pinning a
 * global one says "part of my toolkit", and a toolkit should follow you into
 * the next repo instead of being re-pinned there. So project pins live in the
 * project-local layer beside `showSkillGroups`, and global pins live in the user
 * layer.
 *
 * Identity is the skill NAME, not a path: a skill's directory basename IS its
 * identity on every harness, and it is what survives a re-import, a scope move,
 * or the row being renamed underneath us.
 */

/** Config key path for a scope's pin list. Both live under `appearance.sidebar`. */
export const PIN_FIELD = { project: 'pinnedProjectSkills', global: 'pinnedGlobalSkills' } as const;

/** The pins recorded for one scope, de-duplicated and stripped of blanks. */
export function readPins(
  config: Config | null | undefined,
  scope: SkillScope,
): ReadonlySet<string> {
  const raw = config?.appearance?.sidebar?.[PIN_FIELD[scope]];
  if (!Array.isArray(raw)) return new Set();
  const out = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (name) out.add(name);
  }
  return out;
}

/**
 * The list to write back after toggling one skill. Sorted, so the file does not
 * churn on unrelated edits and two machines that pin the same set agree on the
 * bytes — pins are per-machine today, but the list is small and human-editable
 * and a stable order is what makes it reviewable.
 */
export function togglePin(current: ReadonlySet<string>, name: string, pinned: boolean): string[] {
  const next = new Set(current);
  if (pinned) next.add(name);
  else next.delete(name);
  return [...next].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
