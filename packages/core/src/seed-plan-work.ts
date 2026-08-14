/**
 * "Would applying this seed plan change anything?" — one answer, one place.
 *
 * "Work" has three sources — a file to create, a skill to author, a plugin to
 * enable — and the set grows as packs gain capabilities. One definition, because
 * the callers sit in different packages (the seed dialog and the CLI) and a call
 * site missing a term is not cosmetic: the dialog gates its entire preview on
 * this, so a plan whose only work is enabling a plugin would render empty and
 * tell the user there is nothing to do — exactly the re-seed-after-disabling
 * case the disclosure exists for.
 *
 * Typed structurally rather than against a named plan type so the server's
 * `ScaffoldPlan` and the wire-side `OkScaffoldPlan` both satisfy it without
 * either package importing the other's declaration.
 */

/** The subset of a seed plan this predicate reads. */
export interface SeedPlanWorkShape {
  created: readonly unknown[];
  packSkills?: readonly { pending: boolean }[];
  requiredPlugins?: readonly { pending: boolean }[];
}

/** Whether applying the plan would create a file, author a skill, or enable a plugin. */
export function planHasOutstandingWork(plan: SeedPlanWorkShape): boolean {
  return (
    plan.created.length > 0 ||
    plan.packSkills?.some((skill) => skill.pending) === true ||
    plan.requiredPlugins?.some((plugin) => plugin.pending) === true
  );
}
