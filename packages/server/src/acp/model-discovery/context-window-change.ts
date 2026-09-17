import { launchContextMechanism } from './launch-context.ts';

export type ContextWindowChange =
  | { readonly kind: 'apply' }
  | { readonly kind: 'needs-new-chat' }
  | { readonly kind: 'unsupported' };

export function contextWindowChangeFor(input: {
  readonly agentId: string;
  readonly archived: boolean;
  readonly turnActive: boolean;
  readonly hasStartedWork: boolean;
}): ContextWindowChange {
  if (launchContextMechanism(input.agentId) !== 'codex-config-env') return { kind: 'unsupported' };
  if (input.archived) return { kind: 'needs-new-chat' };
  if (input.turnActive || input.hasStartedWork) return { kind: 'needs-new-chat' };
  return { kind: 'apply' };
}
