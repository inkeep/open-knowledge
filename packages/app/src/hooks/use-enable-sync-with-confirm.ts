import {
  humanFormat,
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

type SyncEnabledWriter = (enabled: boolean) => { ok: true } | { ok: false; error: string };

export function useSyncEnabledWriter(): SyncEnabledWriter | null {
  const { projectLocalBinding } = useConfigContext();
  if (projectLocalBinding === null) return null;
  return (enabled: boolean) => {
    const mode: SyncMode = enabled ? 'full' : 'off';
    const result = projectLocalBinding.patch({ autoSync: { mode, enabled } });
    return result.ok ? { ok: true } : { ok: false, error: humanFormat(result.error) };
  };
}

type SyncModeWriter = (mode: SyncMode) => { ok: true } | { ok: false; error: string };

export function useSyncModeWriter(): SyncModeWriter | null {
  const { projectLocalBinding } = useConfigContext();
  if (projectLocalBinding === null) return null;
  return (mode: SyncMode) => {
    const result = projectLocalBinding.patch({ autoSync: { mode, enabled: null } });
    return result.ok ? { ok: true } : { ok: false, error: humanFormat(result.error) };
  };
}

type SyncDefaultWriter = (
  next: boolean | SyncMode | null,
) => { ok: true } | { ok: false; error: string };

export function useSyncDefaultWriter(): SyncDefaultWriter | null {
  const { projectBinding } = useConfigContext();
  if (projectBinding === null) return null;
  return (next: boolean | SyncMode | null) => {
    const result = projectBinding.patch({ autoSync: { default: next } });
    return result.ok ? { ok: true } : { ok: false, error: humanFormat(result.error) };
  };
}

type SyncIntervalWriter = (next: {
  pullIntervalSeconds: number;
  pushIntervalSeconds: number;
}) => { ok: true } | { ok: false; error: string };

export function useSyncIntervalWriter(): SyncIntervalWriter | null {
  const { projectLocalBinding } = useConfigContext();
  if (projectLocalBinding === null) return null;
  return (next) => {
    const result = projectLocalBinding.patch({ autoSync: next });
    return result.ok ? { ok: true } : { ok: false, error: humanFormat(result.error) };
  };
}

interface UseEnableSyncWithConfirmResult {
  confirmOpen: boolean;
  setConfirmOpen: (open: boolean) => void;
  onToggleRequest: (next: boolean) => void;
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
      setConfirmOpen(true);
      return;
    }
    applyEnabled(false);
  }

  function onConfirm() {
    const ok = applyEnabled(true);
    if (ok) {
      setConfirmOpen(false);
      opts?.onEnabled?.();
    }
  }

  return { confirmOpen, setConfirmOpen, onToggleRequest, onConfirm };
}

type ConfirmableMode = Exclude<SyncMode, 'off'>;

interface UseSyncModeSelectionResult {
  confirmOpen: boolean;
  setConfirmOpen: (open: boolean) => void;
  pendingMode: ConfirmableMode | null;
  onModeSelect: (next: SyncMode) => void;
  onConfirm: () => void;
}

export function useSyncModeSelection(
  writer: SyncModeWriter | null,
  currentMode: SyncMode,
  opts?: { onApplied?: (mode: SyncMode) => void },
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
    opts?.onApplied?.(next);
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
    if (applyMode(pendingMode)) {
      setConfirmOpen(false);
    }
  }

  return { confirmOpen, setConfirmOpen, pendingMode, onModeSelect, onConfirm };
}

type AutoSyncPatch = { mode?: SyncMode; enabled?: null; resumeMode?: SyncActiveMode | null };
type AutoSyncPatchWriter = (patch: AutoSyncPatch) => { ok: true } | { ok: false; error: string };

export function useAutoSyncPatchWriter(): AutoSyncPatchWriter | null {
  const { projectLocalBinding } = useConfigContext();
  if (projectLocalBinding === null) return null;
  return (patch: AutoSyncPatch) => {
    const result = projectLocalBinding.patch({ autoSync: patch });
    return result.ok ? { ok: true } : { ok: false, error: humanFormat(result.error) };
  };
}

interface UseBadgeSyncControlsResult {
  mode: SyncMode;
  confirmOpen: boolean;
  setConfirmOpen: (open: boolean) => void;
  pendingMode: ConfirmableMode | null;
  strandedCommitCount: number;
  onModeSelect: (next: SyncMode) => void;
  onConfirm: () => void;
}

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

  const mode = resolveLocalAutoSyncMode(autoSync) ?? 'off';

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

  function onModeSelect(next: SyncMode) {
    if (next === mode) return;
    if (next === 'off') {
      apply({ mode: 'off', enabled: null, resumeMode: null });
      return;
    }
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
    mode,
    confirmOpen,
    setConfirmOpen,
    pendingMode,
    strandedCommitCount: pendingMode === 'follow' ? aheadCount : 0,
    onModeSelect,
    onConfirm,
  };
}
