export interface SeedPlanWorkShape {
  created: readonly unknown[];
  packSkills?: readonly { pending: boolean }[];
  requiredPlugins?: readonly { pending: boolean }[];
}

export function planHasOutstandingWork(plan: SeedPlanWorkShape): boolean {
  return (
    plan.created.length > 0 ||
    plan.packSkills?.some((skill) => skill.pending) === true ||
    plan.requiredPlugins?.some((plugin) => plugin.pending) === true
  );
}
