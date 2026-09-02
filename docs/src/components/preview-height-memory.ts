export const DEFAULT_PREVIEW_RESERVE_PX = 200;

export const MAX_PREVIEW_HEIGHT_PX = 5000;

const WIDTH_BUCKET_PX = 40;

const STORAGE_KEY = 'ok-docs:preview-heights:v1';

const memory = new Map<string, number>();
let restored = false;

function currentWidthBucket(): number | null {
  if (typeof window === 'undefined') return null;
  return Math.round(window.innerWidth / WIDTH_BUCKET_PX) * WIDTH_BUCKET_PX;
}

function keyFor(code: string, widthBucket: number): string {
  return `${widthBucket}:${code}`;
}

export function recallPreviewHeight(code: string): number | undefined {
  const widthBucket = currentWidthBucket();
  if (widthBucket === null) return undefined;
  return memory.get(keyFor(code, widthBucket));
}

export function rememberPreviewHeight(code: string, height: number): void {
  const widthBucket = currentWidthBucket();
  if (widthBucket === null) return;
  if (!Number.isFinite(height) || height <= 0 || height > MAX_PREVIEW_HEIGHT_PX) return;

  const key = keyFor(code, widthBucket);
  if (memory.get(key) === height) return;

  memory.set(key, height);
  persist();
}

function persist(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(memory)));
  } catch {}
}

export function restorePreviewHeights(): void {
  if (restored) return;
  restored = true;

  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    for (const [key, height] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
      if (typeof height === 'number' && height > 0 && height <= MAX_PREVIEW_HEIGHT_PX) {
        if (!memory.has(key)) memory.set(key, height);
      }
    }
  } catch {}
}

export function resetPreviewHeightMemory(): void {
  memory.clear();
  restored = false;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
}
