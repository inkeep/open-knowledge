import type { ResolvedLaunch } from '../launch.ts';
import { withCodexContextWindow } from './codex-context.ts';

export type LaunchContextMechanism = 'codex-config-env' | 'model-variant' | 'none';

const LAUNCH_CONTEXT_MECHANISMS: Readonly<Record<string, LaunchContextMechanism>> = {
  'codex-acp': 'codex-config-env',
  'claude-acp': 'model-variant',
};

export function launchContextMechanism(agentId: string): LaunchContextMechanism {
  return LAUNCH_CONTEXT_MECHANISMS[agentId] ?? 'none';
}

export function applyLaunchContextWindow(
  launch: ResolvedLaunch,
  agentId: string,
  requestedTokens: number | null,
): ResolvedLaunch {
  if (requestedTokens === null) return launch;
  if (launchContextMechanism(agentId) !== 'codex-config-env') return launch;
  const env = withCodexContextWindow(launch.env, requestedTokens);
  return env === launch.env ? launch : { ...launch, env };
}
