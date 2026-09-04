import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { createContext, type ReactNode, use } from 'react';
import type { HandoffDispatchInput } from './useHandoffDispatch';

export interface TerminalLaunchContextValue {
  readonly launchInTerminal: (input: HandoffDispatchInput, cli: TerminalCli) => void;
  readonly installedClis: Partial<Record<TerminalCli, boolean>>;
}

const TerminalLaunchContext = createContext<TerminalLaunchContextValue | null>(null);

export function TerminalLaunchProvider({
  value,
  children,
}: {
  readonly value: TerminalLaunchContextValue | null;
  readonly children: ReactNode;
}): ReactNode {
  return <TerminalLaunchContext value={value}>{children}</TerminalLaunchContext>;
}

export function useTerminalLaunch(): TerminalLaunchContextValue | null {
  return use(TerminalLaunchContext);
}
