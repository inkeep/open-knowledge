import { humanFormat } from '@inkeep/open-knowledge-core';
import { useConfigContext } from '@/lib/config-provider';
import { recordShellConsentGranted } from '@/lib/terminal-telemetry';

export type TerminalEnabledWriter = (
  enabled: boolean,
) => { ok: true } | { ok: false; error: string };

export interface TerminalConsentState {
  enabled: boolean | null;
  synced: boolean;
}

export function useTerminalConsentState(): TerminalConsentState {
  const { projectLocalConfig, projectLocalSynced } = useConfigContext();
  return {
    enabled: projectLocalConfig?.terminal?.enabled ?? null,
    synced: projectLocalSynced,
  };
}

export function useTerminalEnabledWriter(): TerminalEnabledWriter | null {
  const { projectLocalBinding } = useConfigContext();
  if (projectLocalBinding === null) return null;
  return (enabled: boolean) => {
    const result = projectLocalBinding.patch({ terminal: { enabled } });
    if (result.ok && enabled) recordShellConsentGranted();
    return result.ok ? { ok: true } : { ok: false, error: humanFormat(result.error) };
  };
}
