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
import {
  displayActiveMode,
  hasEverEnabledSync,
  humanFormat,
  isSyncPaused,
  resolveLocalAutoSyncMode,
  type StoredSyncActiveMode,
  type StoredSyncMode,
  type SyncActiveMode,
  type SyncMode,
} from '@inkeep/open-knowledge-core';
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
 * Legacy boolean writer targeting the project-local `autoSync.enabled` leaf.
 * Retained for the full-sync enable/disable surfaces that predate the three-way
 * mode (the share-receive recovery CTAs). The engine still honors `enabled`
 * (`resolveLocalAutoSyncMode` derives a mode from it when `mode` is absent), so
 * these surfaces keep working; new mode-aware surfaces use `useSyncModeWriter`.
 *
 * Returns `null` until the binding mounts (cold-start window before the
 * Hocuspocus provider connects); callers check for null before writing.
 */
export function useSyncEnabledWriter(): SyncEnabledWriter | null {
  const { projectLocalBinding } = useConfigContext();
  if (projectLocalBinding === null) return null;
  return (enabled: boolean) => {
    // Write `mode` too, not just the legacy `enabled` leaf. `resolveLocalAutoSyncMode`
    // reads `mode` first, so on a machine that already chose a mode (e.g. `off` via
    // Settings) a bare `{ enabled: true }` is a silent no-op — the stale `mode` wins.
    // The legacy writer only ever maps to full/off, so the paired `enabled` stays a
    // truthful mirror (no cross-version disagreement) while `mode` drives resolution.
    const mode: SyncMode = enabled ? 'full' : 'off';
    const result = projectLocalBinding.patch({ autoSync: { mode, enabled } });
    return result.ok ? { ok: true } : { ok: false, error: humanFormat(result.error) };
  };
}

/** Adapter that persists a chosen sync mode to the project-local `autoSync.mode`. */
type SyncModeWriter = (mode: SyncMode) => { ok: true } | { ok: false; error: string };

/**
 * Build a `SyncModeWriter` targeting the project-local config binding — the
 * mode-aware successor to `useSyncEnabledWriter`. Writes the canonical
 * `autoSync.mode` knob ('off' | 'follow' | 'full'), the single value the engine
 * reads to decide whether to push. Returns `null` until the binding mounts.
 *
 * Single source of the binding → writer translation so every consent surface
 * (onboarding prompt, Settings, badge) shares the `humanFormat(error)` wrapping.
 */
export function useSyncModeWriter(): SyncModeWriter | null {
  const { projectLocalBinding } = useConfigContext();
  if (projectLocalBinding === null) return null;
  return (mode: SyncMode) => {
    // Clear the legacy `enabled` flag as we set `mode`. Leaving a stale
    // `enabled: true` behind lets an app that predates `mode` read the project
    // as full-sync and push for a mode the user switched away from; `null` is
    // the "unanswered" sentinel, so the two layers can never disagree.
    const result = projectLocalBinding.patch({ autoSync: { mode, enabled: null } });
    return result.ok ? { ok: true } : { ok: false, error: humanFormat(result.error) };
  };
}

/**
 * Adapter for the COMMITTED project sync default (`autoSync.default`). Unlike
 * `SyncEnabledWriter` (a per-machine boolean), this carries the seed the
 * maintainer ships to everyone. It accepts the mode vocabulary (`'off'` |
 * `'follow'` | `'full'`) as well as the legacy boolean seed (`true` = full,
 * `false` = off); `null` = ask (clears the committed key via RFC 7396 merge-patch,
 * restoring the onboarding prompt).
 */
type SyncDefaultWriter = (
  next: boolean | SyncMode | null,
) => { ok: true } | { ok: false; error: string };

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
  return (next: boolean | SyncMode | null) => {
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

/** The two modes whose selection crosses a consent boundary and must confirm. */
type ConfirmableMode = Exclude<SyncMode, 'off'>;

interface UseSyncModeSelectionResult {
  /** Whether the confirmation dialog is open. */
  confirmOpen: boolean;
  /** Open/close the confirmation dialog (controlled). */
  setConfirmOpen: (open: boolean) => void;
  /**
   * The mode a pending confirmation will apply; `null` when idle. Drives the
   * confirm dialog's variant ('follow' vs 'full' copy).
   */
  pendingMode: ConfirmableMode | null;
  /** Call with the mode the user picked in the three-way selector. */
  onModeSelect: (next: SyncMode) => void;
  /** Call from the confirmation dialog's confirm button. */
  onConfirm: () => void;
}

/**
 * Mode-aware counterpart to {@link useEnableSyncWithConfirm} for the three-way
 * sync-mode selector. Selecting `off` commits immediately (turning sync off
 * never pushes or rewrites the tree — the safe direction). Selecting `pull` or
 * `full`, or escalating `pull`→`full`, gates behind the confirmation dialog so
 * enabling is always an explicit, informed act. Re-selecting the current mode is
 * a no-op.
 *
 * `currentMode` is the resolved per-machine mode; the caller renders
 * `<EnableSyncConfirmDialog variant={pendingMode ?? 'full'} ...>` with the
 * returned props.
 */
export function useSyncModeSelection(
  writer: SyncModeWriter | null,
  currentMode: SyncMode,
): UseSyncModeSelectionResult {
  const { t } = useLingui();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<ConfirmableMode | null>(null);

  function applyMode(next: SyncMode): boolean {
    if (writer === null) {
      toast.error(t`Sync settings not yet loaded — try again in a moment`);
      return false;
    }
    const result = writer(next);
    if (!result.ok) {
      console.error('[sync] mode change failed:', result.error);
      const detail = result.error;
      toast.error(t`Failed to update sync mode — ${detail}`);
      return false;
    }
    return true;
  }

  function onModeSelect(next: SyncMode) {
    if (next === currentMode) return;
    if (next === 'off') {
      applyMode('off');
      return;
    }
    setPendingMode(next);
    setConfirmOpen(true);
  }

  function onConfirm() {
    if (pendingMode === null) return;
    // Close only on success — a failed write keeps the dialog up so the user can
    // retry, matching the boolean confirm path.
    if (applyMode(pendingMode)) {
      setConfirmOpen(false);
    }
  }

  return { confirmOpen, setConfirmOpen, pendingMode, onModeSelect, onConfirm };
}

/** Fields the badge control patches on the project-local `autoSync` object. */
type AutoSyncPatch = { mode?: SyncMode; enabled?: null; resumeMode?: SyncActiveMode | null };
type AutoSyncPatchWriter = (patch: AutoSyncPatch) => { ok: true } | { ok: false; error: string };

/**
 * Low-level writer for an arbitrary project-local `autoSync` merge-patch — the
 * badge control needs to set `mode` and `resumeMode` together (or `resumeMode`
 * alone while paused), which the single-value {@link useSyncModeWriter} can't
 * express. A `resumeMode: null` clears the key via RFC 7396 merge-patch. Returns
 * `null` until the binding mounts.
 */
export function useAutoSyncPatchWriter(): AutoSyncPatchWriter | null {
  const { projectLocalBinding } = useConfigContext();
  if (projectLocalBinding === null) return null;
  return (patch: AutoSyncPatch) => {
    const result = projectLocalBinding.patch({ autoSync: patch });
    return result.ok ? { ok: true } : { ok: false, error: humanFormat(result.error) };
  };
}

interface UseBadgeSyncControlsResult {
  /** Sync is running (mode pull or full) — the header Switch is on. */
  active: boolean;
  /** Sync was enabled then turned off — badge stays visible, mode still editable. */
  paused: boolean;
  /** Sync has ever been enabled — gates the manual "Sync" action. */
  everEnabled: boolean;
  /** The value the Full/Follow control shows: live mode when active, else the resume memory. */
  toggleMode: SyncActiveMode;
  confirmOpen: boolean;
  setConfirmOpen: (open: boolean) => void;
  /** Drives the confirm dialog variant ('follow' vs 'full'); null when idle. */
  pendingMode: ConfirmableMode | null;
  /** Unpushed commits disclosed on a full→follow downgrade confirm (0 otherwise). */
  strandedCommitCount: number;
  /** Header Switch handler: on = resume into `toggleMode`, off = pause. */
  onToggleActive: (next: boolean) => void;
  /** Full/Follow control handler. */
  onModeSelect: (next: SyncActiveMode) => void;
  onConfirm: () => void;
}

/**
 * Sync controls for the badge popover, where the header Switch means
 * active-vs-paused (not a mode) and a separate Full/Follow control sets the
 * mode. Pausing persists as `mode: 'off'` plus a remembered `resumeMode`, so an
 * older app reads a paused project as not-syncing (never pushes) while this app
 * can restore the prior mode. Entering `full` (which pushes) always confirms;
 * resuming into or staying on `pull` never pushes, so it applies immediately.
 * While paused, changing the Full/Follow control only updates the resume memory
 * — nothing syncs until the Switch is turned back on.
 */
export function useBadgeSyncControls(
  autoSync:
    | {
        mode?: StoredSyncMode | null;
        enabled?: boolean | null;
        resumeMode?: StoredSyncActiveMode | null;
      }
    | undefined,
  aheadCount: number,
): UseBadgeSyncControlsResult {
  const { t } = useLingui();
  const writer = useAutoSyncPatchWriter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<ConfirmableMode | null>(null);

  const localMode = resolveLocalAutoSyncMode(autoSync) ?? 'off';
  const active = localMode === 'follow' || localMode === 'full';
  const paused = isSyncPaused(autoSync);
  const everEnabled = hasEverEnabledSync(autoSync);
  const toggleMode = displayActiveMode(autoSync);

  function apply(patch: AutoSyncPatch): boolean {
    if (writer === null) {
      toast.error(t`Sync settings not yet loaded — try again in a moment`);
      return false;
    }
    const result = writer(patch);
    if (!result.ok) {
      console.error('[sync] badge control failed:', result.error);
      const detail = result.error;
      toast.error(t`Failed to update sync — ${detail}`);
      return false;
    }
    return true;
  }

  function onToggleActive(next: boolean) {
    if (next) {
      // Resume into the remembered mode. Full pushes, so it confirms; pull does
      // not, so it applies immediately (the user consented before pausing).
      if (toggleMode === 'full') {
        setPendingMode('full');
        setConfirmOpen(true);
        return;
      }
      apply({ mode: 'follow', enabled: null, resumeMode: null });
      return;
    }
    // Pause: store 'off' (so an old app never pushes) and remember the mode.
    apply({
      mode: 'off',
      enabled: null,
      resumeMode: active ? (localMode as SyncActiveMode) : toggleMode,
    });
  }

  function onModeSelect(next: SyncActiveMode) {
    if (next === toggleMode) return;
    if (!active) {
      // Paused/off: just remember which mode to resume into — nothing syncs yet,
      // so no push and no confirmation.
      apply({ resumeMode: next });
      return;
    }
    // Active: entering full pushes; downgrading full→follow strands unpushed
    // commits — both cross a consent boundary, so confirm.
    setPendingMode(next);
    setConfirmOpen(true);
  }

  function onConfirm() {
    if (pendingMode === null) return;
    if (apply({ mode: pendingMode, enabled: null, resumeMode: null })) {
      setConfirmOpen(false);
      setPendingMode(null);
    }
  }

  return {
    active,
    paused,
    everEnabled,
    toggleMode,
    confirmOpen,
    setConfirmOpen,
    pendingMode,
    strandedCommitCount: pendingMode === 'follow' ? aheadCount : 0,
    onToggleActive,
    onModeSelect,
    onConfirm,
  };
}
