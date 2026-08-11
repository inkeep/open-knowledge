/**
 * Remembers how tall each `html preview` block turned out to be, so a block
 * that has already been measured reserves its real height the next time it is
 * rendered instead of falling back to a placeholder guess and reflowing the
 * page underneath it.
 *
 * Heights are keyed by width as well as by block. The preview content is
 * responsive, and the docs column itself changes width at layout breakpoints,
 * so the same block legitimately settles at different heights: one block
 * measures 240px on a desktop column and 422px on a phone. A height recalled
 * for the wrong width would be as wrong as the constant it replaced, so a
 * different width is a cache miss rather than a stale hit.
 */

/**
 * What to reserve for a block nobody has measured yet. A sandboxed iframe
 * cannot be sized without rendering it, so the very first view of a block at a
 * given width has nothing better to go on than a guess.
 */
export const DEFAULT_PREVIEW_RESERVE_PX = 200;

/** Ignore an implausible height rather than persisting it. */
export const MAX_PREVIEW_HEIGHT_PX = 5000;

/**
 * Bucket width so that ordinary window resizing, scrollbar appearance, and
 * sub-pixel layout differences do not each mint a separate entry. Coarse enough
 * to hit on a revisit, fine enough that a real breakpoint change misses.
 */
const WIDTH_BUCKET_PX = 40;

const STORAGE_KEY = 'ok-docs:preview-heights:v1';

const memory = new Map<string, number>();
let restored = false;

/**
 * `null` when there is no window to measure — during server rendering, and
 * therefore also during the client's hydrating render, which keeps the reserve
 * identical on both sides.
 */
function currentWidthBucket(): number | null {
  if (typeof window === 'undefined') return null;
  return Math.round(window.innerWidth / WIDTH_BUCKET_PX) * WIDTH_BUCKET_PX;
}

function keyFor(code: string, widthBucket: number): string {
  return `${widthBucket}:${code}`;
}

/** The height this block last settled at, at the current width, if known. */
export function recallPreviewHeight(code: string): number | undefined {
  const widthBucket = currentWidthBucket();
  if (widthBucket === null) return undefined;
  return memory.get(keyFor(code, widthBucket));
}

/** Record what a block actually measured, so the next render can reserve it. */
export function rememberPreviewHeight(code: string, height: number): void {
  const widthBucket = currentWidthBucket();
  if (widthBucket === null) return;
  if (!Number.isFinite(height) || height <= 0 || height > MAX_PREVIEW_HEIGHT_PX) return;

  const key = keyFor(code, widthBucket);
  // The frame re-reports its height on load, on every ResizeObserver fire, and
  // on a 250ms interval for its first six seconds. Almost all of those repeat a
  // height already recorded, so bail before re-serialising the whole map.
  if (memory.get(key) === height) return;

  memory.set(key, height);
  persist();
}

/**
 * Mirror into sessionStorage so heights survive a reload within the session.
 *
 * Storage is unavailable or throws in private-browsing and locked-down cookie
 * modes. That is a real boundary rather than a masked error: the memory is an
 * optimisation, and losing it costs a one-time reflow, not correctness.
 */
function persist(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(memory)));
  } catch {
    // Session storage is unavailable; in-memory recall still works for this page.
  }
}

/**
 * Load persisted heights into the in-memory map.
 *
 * MUST be called from an effect, never during render. Reading storage while
 * rendering would let the client's first render disagree with the server's
 * markup and produce a hydration mismatch on the reserved height. Deferring it
 * keeps the hydrating render identical to the server's while still making the
 * heights available to every client-side navigation that follows, which is the
 * case that actually reflows today.
 */
export function restorePreviewHeights(): void {
  if (restored) return;
  restored = true;

  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    for (const [key, height] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
      if (typeof height === 'number' && height > 0 && height <= MAX_PREVIEW_HEIGHT_PX) {
        // A height measured in this session is more current than a stored one.
        if (!memory.has(key)) memory.set(key, height);
      }
    }
  } catch {
    // Unreadable or malformed storage; fall back to measuring afresh.
  }
}

/**
 * Drop everything remembered so far, persisted copy included. Exists so tests
 * can start from a known state; clearing storage too is what makes them
 * independent of each other, since a leftover entry would otherwise be restored
 * into the next test.
 */
export function resetPreviewHeightMemory(): void {
  memory.clear();
  restored = false;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage itself is unreachable (private mode, blocked cookies), so there is
    // nothing persisted to clear anyway.
  }
}
