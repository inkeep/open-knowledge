export interface AuditGenerationInputs {
  lintConfigEpoch: number;
  projectConfigEpoch: number;
  activeBranch: string;
  localTargetGeneration: string | number;
}

export function composeAuditGeneration(inputs: AuditGenerationInputs): string {
  return [
    inputs.lintConfigEpoch,
    inputs.projectConfigEpoch,
    inputs.activeBranch,
    inputs.localTargetGeneration,
  ].join(' ');
}
