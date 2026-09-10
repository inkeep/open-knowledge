import {
  ACP_AGENT_HARNESS_CLI_MAP,
  TERMINAL_CLI_IDS,
  type TerminalCli,
} from '@inkeep/open-knowledge-core';
import { useInstalledClis } from '@/hooks/use-installed-clis';
import { isNoteWindow } from '@/lib/note-window-mode';

export function harnessTerminalCli(
  agentId: string,
  installedClis: Partial<Record<TerminalCli, boolean>>,
  terminalAvailable: boolean,
): TerminalCli | null {
  if (!terminalAvailable) return null;
  const harness = ACP_AGENT_HARNESS_CLI_MAP[agentId];
  if (harness === undefined) return null;
  const launchable: readonly string[] = TERMINAL_CLI_IDS;
  if (!launchable.includes(harness)) return null;
  const cli = harness as TerminalCli;
  return installedClis[cli] === true ? cli : null;
}

function terminalLaunchAvailable(): boolean {
  if (typeof window === 'undefined' || isNoteWindow()) return false;
  const bridge = window.okDesktop ?? null;
  return bridge?.terminal != null && bridge.config.ptyAvailable === true;
}

export function useHarnessTerminalCli(agentId: string): TerminalCli | null {
  const installedClis = useInstalledClis();
  return harnessTerminalCli(agentId, installedClis, terminalLaunchAvailable());
}
