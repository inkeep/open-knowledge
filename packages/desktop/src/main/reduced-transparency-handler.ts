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

const preferredMaterial = new WeakMap<BrowserWindowVibrancyTarget, VibrancyMaterial>();

export function setPreferredWindowVibrancy(
  win: BrowserWindowVibrancyTarget,
  material: VibrancyMaterial,
): void {
  preferredMaterial.set(win, material);
}

export function applyReducedTransparency(
  deps: ReducedTransparencyDeps,
  reducedTransparency: boolean,
): void {
  let windowCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let destroyedCount = 0;
  const vibrancyMaterials: Partial<Record<VibrancyMaterial | 'none', number>> = {};
  const recordMaterial = (material: VibrancyMaterial | null): void => {
    const key = material ?? 'none';
    vibrancyMaterials[key] = (vibrancyMaterials[key] ?? 0) + 1;
  };
  for (const win of deps.getAllWindows()) {
    if (win.isDestroyed?.() === true) {
      destroyedCount += 1;
      continue;
    }
    const material: VibrancyMaterial | null = reducedTransparency
      ? null
      : (preferredMaterial.get(win) ?? deps.defaultVibrancy);
    if (lastAppliedMaterial.get(win) === material) {
      recordMaterial(material);
      skippedCount += 1;
      continue;
    }
    try {
      win.setVibrancy(material);
      lastAppliedMaterial.set(win, material);
      recordMaterial(material);
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
      vibrancy: reducedTransparency ? null : deps.defaultVibrancy,
      vibrancyMaterials,
      windowCount,
      skippedCount,
      failedCount,
      destroyedCount,
    }),
  );
}
