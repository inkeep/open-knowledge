import type { TerminalCli } from '@inkeep/open-knowledge-core/handoff';
import { usePreferBareTerminal } from '../terminal-new-tab-store';
import { useStickyAgent } from '../unified-agent-store';
import { useEnabledOverrides } from './enabled-agents';
import {
  enabledTerminalClis,
  enabledThreadAgents,
  resolveLauncherSelection,
} from './launcher-selection';
import {
  pickEffectiveDefaultAgent,
  useDefaultRegisteredAgent,
  useRegisteredAgents,
} from './registered-agents';

export function usePreferredSessionSelection({
  installedClis,
  terminalAvailable,
  threadsAvailable,
}: {
  installedClis: Partial<Record<TerminalCli, boolean>>;
  terminalAvailable: boolean;
  threadsAvailable: boolean;
}) {
  const registeredAgents = useRegisteredAgents();
  const defaultRegisteredAgent = useDefaultRegisteredAgent();
  const enabledOverrides = useEnabledOverrides();
  const sticky = useStickyAgent();
  const preferBareTerminal = usePreferBareTerminal();

  return resolveLauncherSelection({
    sticky,
    effectiveThreadAgent: pickEffectiveDefaultAgent(
      enabledThreadAgents(registeredAgents, enabledOverrides),
      defaultRegisteredAgent,
    ),
    enabledClis: enabledTerminalClis(enabledOverrides, installedClis),
    enabledDesktopTargets: [],
    installedClis,
    terminalAvailable,
    threadsAvailable,
    desktopSelectable: false,
    preferBareTerminal,
    bareTerminalFallback: true,
  });
}
