export type VibrancyMaterial = 'sidebar' | 'window';

export interface BrowserWindowVibrancyTarget {
  isDestroyed?: () => boolean;
  readonly id?: number;
  setVibrancy: (mat: VibrancyMaterial | null) => void;
}

export interface ReducedTransparencyDeps {
  getAllWindows: () => readonly BrowserWindowVibrancyTarget[];
  defaultVibrancy: VibrancyMaterial;
  warn?: (line: string) => void;
}

const lastAppliedMaterial = new WeakMap<BrowserWindowVibrancyTarget, VibrancyMaterial | null>();

export function applyReducedTransparency(
  deps: ReducedTransparencyDeps,
  reducedTransparency: boolean,
): void {
  const material: VibrancyMaterial | null = reducedTransparency ? null : deps.defaultVibrancy;
  let windowCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let destroyedCount = 0;
  for (const win of deps.getAllWindows()) {
    if (win.isDestroyed?.() === true) {
      destroyedCount += 1;
      continue;
    }
    if (lastAppliedMaterial.get(win) === material) {
      skippedCount += 1;
      continue;
    }
    try {
      win.setVibrancy(material);
      lastAppliedMaterial.set(win, material);
      windowCount += 1;
    } catch (err) {
      failedCount += 1;
      deps.warn?.(
        JSON.stringify({
          event: 'reduced-transparency-window-failed',
          windowId: win.id,
          vibrancy: material,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  deps.warn?.(
    JSON.stringify({
      event: 'reduced-transparency-applied',
      reducedTransparency,
      vibrancy: material,
      windowCount,
      skippedCount,
      failedCount,
      destroyedCount,
    }),
  );
}
