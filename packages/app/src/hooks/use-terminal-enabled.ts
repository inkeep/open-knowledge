/**
 * Project-local consent state + writer for the in-app terminal's real OS shell.
 *
 * Reads and writes the `terminal.enabled` leaf on the project-local
 * ConfigBinding (`<projectDir>/.ok/local/config.yml`, gitignored), cloning the
 * `git.autoSync.enabled` rail (`use-enable-sync-with-confirm`). The leaf is
 * `agentSettable: false`, so this human-only renderer binding is the only path
 * that can grant or revoke the shell.
 *
 * Tri-state: `null` = never chosen (the just-in-time consent prompt fires),
 * `true` = granted, `false` = revoked. `synced` distinguishes a `null` that
 * means "unanswered" from the cold-start default before the project-local doc
 * hydrates.
 */
import { humanFormat } from '@inkeep/open-knowledge-core';
import { useConfigContext } from '@/lib/config-provider';
import { recordShellConsentGranted } from '@/lib/terminal-telemetry';

export type TerminalEnabledWriter = (
  enabled: boolean,
) => { ok: true } | { ok: false; error: string };

export interface TerminalConsentState {
  /** `null` = unanswered, `true` = granted, `false` = revoked. */
  enabled: boolean | null;
  /** True once the project-local binding has observed its first `'synced'`. */
  synced: boolean;
}

/**
 * Read the project-local terminal-consent state. Reads the project-local
 * binding directly (not the layered merge): `terminal.enabled` is
 * `scope: 'project-local'`, so only that layer is authoritative.
 */
export function useTerminalConsentState(): TerminalConsentState {
  const { projectLocalConfig, projectLocalSynced } = useConfigContext();
  return {
    enabled: projectLocalConfig?.terminal?.enabled ?? null,
    synced: projectLocalSynced,
  };
}

/**
 * Build a writer that grants (`true`) or revokes (`false`) the shell on the
 * project-local binding. Returns `null` until the binding mounts (cold-start
 * window) — callers must check before letting the user trigger a write.
 */
export function useTerminalEnabledWriter(): TerminalEnabledWriter | null {
  const { projectLocalBinding } = useConfigContext();
  if (projectLocalBinding === null) return null;
  return (enabled: boolean) => {
    const result = projectLocalBinding.patch({ terminal: { enabled } });
    // Single chokepoint for the grant signal: both the JIT dialog and the
    // Settings re-enable write `true` through here. Only a successful grant
    // (never a revoke) is intent-to-use telemetry.
    if (result.ok && enabled) recordShellConsentGranted();
    return result.ok ? { ok: true } : { ok: false, error: humanFormat(result.error) };
  };
}
