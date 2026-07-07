/**
 * useEnableSyncWithConfirm — shared toggle wiring for the git auto-sync
 * Switch in the SyncStatusBadge popover and the SettingsDialog Sync section.
 *
 * Off → on opens a confirmation dialog and only commits the write after the
 * user confirms. On → off commits immediately (safe direction).
 *
 * The dialog state lives here so both surfaces share the same gate; the
 * caller renders <EnableSyncConfirmDialog> with the returned props.
 *
 * `opts.onEnabled` (optional) fires once, on a SUCCESSFUL enable, so a host
 * surface can dismiss itself on the same confirm click (e.g. the share-receive
 * miss dialog closing after the user chooses Enable auto-sync). It never fires
 * on a failed write or on the on → off direction.
 *
 * The hook accepts a `writer` so the toggle is decoupled from any specific
 * persistence backend. Today the writer is always a `ConfigBinding.patch`
 * adapter targeting `__local__/project`; tests inject fakes; future
 * surfaces (CLI, Tauri IPC) can supply their own without touching this
 * hook.
 */
import { humanFormat } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { toast } from 'sonner';
import { useConfigContext } from '@/lib/config-provider';

/**
 * Adapter shape used to actually persist the choice. Sync-returning so it
 * matches `ConfigBinding.patch`'s contract directly; the hook does not
 * await it. Returns a tagged Result so the hook can render success / error
 * UX without re-throwing.
 */
type SyncEnabledWriter = (enabled: boolean) => { ok: true } | { ok: false; error: string };

/**
 * Build a `SyncEnabledWriter` that targets the project-local config binding
 * from `ConfigProvider`. Returns `null` until the binding mounts (cold-
 * start window before the Hocuspocus provider connects); callers should
 * check for null before letting the user trigger a write.
 *
 * Single source of the binding → writer translation so adding a future
 * surface (e.g. a keyboard-shortcut quick-toggle) doesn't need to recreate
 * the `humanFormat(error)` wrapping.
 */
export function useSyncEnabledWriter(): SyncEnabledWriter | null {
  const { projectLocalBinding } = useConfigContext();
  if (projectLocalBinding === null) return null;
  return (enabled: boolean) => {
    const result = projectLocalBinding.patch({ autoSync: { enabled } });
    return result.ok ? { ok: true } : { ok: false, error: humanFormat(result.error) };
  };
}

/**
 * Adapter for the COMMITTED project sync default (`autoSync.default`). Unlike
 * `SyncEnabledWriter` (a per-machine boolean), this carries the tri-state seed
 * the maintainer ships to everyone: `true` = default on, `false` = default off,
 * `null` = ask (clears the committed key via RFC 7396 merge-patch, restoring the
 * onboarding prompt).
 */
type SyncDefaultWriter = (next: boolean | null) => { ok: true } | { ok: false; error: string };

/**
 * Build a `SyncDefaultWriter` targeting the COMMITTED project ConfigBinding
 * (`__config__/project`) — the value lands in `.ok/config.yml` and travels with
 * the repo via git. Returns `null` until the binding mounts. Deliberately
 * separate from `useSyncEnabledWriter` (per-machine, project-local): the two
 * write different scopes and must never be confused.
 */
export function useSyncDefaultWriter(): SyncDefaultWriter | null {
  const { projectBinding } = useConfigContext();
  if (projectBinding === null) return null;
  return (next: boolean | null) => {
    const result = projectBinding.patch({ autoSync: { default: next } });
    return result.ok ? { ok: true } : { ok: false, error: humanFormat(result.error) };
  };
}

interface UseEnableSyncWithConfirmResult {
  /** Whether the confirmation dialog is open. */
  confirmOpen: boolean;
  /** Open/close the confirmation dialog (controlled). */
  setConfirmOpen: (open: boolean) => void;
  /** Call when the Switch fires onCheckedChange(next). */
  onToggleRequest: (next: boolean) => void;
  /** Call from the dialog's confirm button. */
  onConfirm: () => void;
}

export function useEnableSyncWithConfirm(
  writer: SyncEnabledWriter | null,
  opts?: { onEnabled?: () => void },
): UseEnableSyncWithConfirmResult {
  const { t } = useLingui();
  const [confirmOpen, setConfirmOpen] = useState(false);

  function applyEnabled(next: boolean): boolean {
    if (writer === null) {
      toast.error(t`Sync settings not yet loaded — try again in a moment`);
      return false;
    }
    const result = writer(next);
    if (!result.ok) {
      console.error('[sync] toggle failed:', result.error);
      const detail = result.error;
      toast.error(
        next ? t`Failed to enable sync — ${detail}` : t`Failed to disable sync — ${detail}`,
      );
      return false;
    }
    return true;
  }

  function onToggleRequest(next: boolean) {
    if (next) {
      // Off → on: gate behind the confirmation dialog.
      setConfirmOpen(true);
      return;
    }
    // On → off: commit immediately. Disabling is the safe direction.
    applyEnabled(false);
  }

  function onConfirm() {
    // Close only on success — closing on failure would contradict the
    // error toast and force the user to re-trigger the toggle to retry.
    const ok = applyEnabled(true);
    if (ok) {
      setConfirmOpen(false);
      // Success-only notify so a host surface can dismiss itself on the same
      // click. A failed write leaves both dialogs up so the user can retry.
      opts?.onEnabled?.();
    }
  }

  return { confirmOpen, setConfirmOpen, onToggleRequest, onConfirm };
}
