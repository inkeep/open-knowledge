/**
 * Main-process helper that puts an image on the OS clipboard the same
 * shape a macOS system screenshot / CleanShot writes: the 9-flavor
 * raster set macOS's pasteboard writer expands an NSImage into
 * (`«class PNGf»`, `TIFF picture`, `JPEG picture`, `GIF picture`,
 * `«class jp2»`, `«class BMP»`, `«class TPIC»`, `«class 8BPS»`,
 * `«class AVIF»`). Every rich receiver we tested (Notes, Docs, Slack
 * chat, Notion inline, iMessage) picks a compatible raster and renders
 * inline first-try.
 *
 * Renderer's own `navigator.clipboard.write` can't produce that 9-flavor
 * set — Chromium's Async Clipboard API only accepts one blob per MIME
 * key — which is why the copy has to run in main. `nativeImage` is the
 * transport into NSImage.
 *
 * The bytes come from disk when the src is same-origin as the asset
 * serve (path resolved + canonicalized against the project root — same
 * `realpath` + containment gate as `openAssetSafely`), and from a
 * network `fetch` otherwise.
 */

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import * as pathPosix from 'node:path/posix';
import * as pathWin32 from 'node:path/win32';
import type { Clipboard, NativeImage } from 'electron';
import { isPathWithinProject } from './ipc-handlers.ts';

/**
 * Extensions `nativeImage.createFromBuffer` decodes on macOS. Electron's
 * `AddImageSkiaRepFromBuffer` tries PNG then JPEG then a raw bitmap
 * shape that needs explicit `width`/`height` (which this call site
 * doesn't have). WebP / GIF / BMP land in the empty-image branch and
 * fall back to the renderer's `navigator.clipboard.write` path — kept
 * off this list so the fallback fires without the confusing detour
 * through a decode we already know will fail.
 */
const CLIPBOARD_IMAGE_EXTS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg']);

type CopyImageResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'fetch-failed' | 'path-escape' | 'empty-image' | 'read-error' | 'write-error';
      detail?: string;
    };

export interface CopyImageToClipboardDeps {
  readonly projectPath: string;
  readonly platform: NodeJS.Platform;
  /** Full origin (`http://localhost:<port>`) the OK asset serve is bound to for
   *  this window — same-origin URLs resolve to on-disk paths under project. */
  readonly assetOrigin: string;
  /**
   * Electron `clipboard` + `nativeImage`. Injected so tests can stub.
   * `clear` is intentionally not in the Pick — `writeImage` on macOS
   * clears+writes atomically at the NSPasteboard level, and calling
   * `clear` explicitly would open a wipe-then-throw window where the
   * user's prior clipboard is gone with nothing to replace it.
   */
  readonly clipboard: Pick<Clipboard, 'writeImage'>;
  readonly nativeImage: {
    createFromBuffer(buffer: Buffer): Pick<NativeImage, 'isEmpty'>;
  };
  /** Optional network fetch — defaults to `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /** Test seams — default to `realpathSync`. Failures map to `read-error`. */
  readonly resolveCanonical?: (path: string) => string;
  /** Test seam — defaults to `fs/promises` `readFile`. Failures map to `read-error`. */
  readonly readFile?: (path: string) => Promise<Buffer>;
}

export interface CopyImageInput {
  /** Absolute URL the renderer resolved off the live img (currentSrc / src). */
  readonly src: string;
  /** Alt attribute — currently unused, kept in the payload so a future
   *  human-readable filename step can seed on it without a shape change. */
  readonly alt: string;
}

/**
 * Fetch the image bytes for `src`, decode via nativeImage, and write to
 * the OS clipboard via `writeImage`. `{ok: false, reason}` on every
 * classifiable failure so the renderer's `navigator.clipboard.write`
 * fallback can fire.
 */
export async function copyImageToClipboard(
  deps: CopyImageToClipboardDeps,
  input: CopyImageInput,
): Promise<CopyImageResult> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const bytesResult = await loadImageBytes(deps, input.src, fetchImpl);
  if (!bytesResult.ok) return bytesResult;
  const { bytes, ext } = bytesResult;

  const img = deps.nativeImage.createFromBuffer(bytes);
  if (img.isEmpty()) {
    return { ok: false, reason: 'empty-image', detail: `nativeImage empty for .${ext}` };
  }

  // Raster-only clipboard write. `clipboard.writeImage` on macOS routes
  // through NSImage; the pasteboard writer expands that into the
  // 9-flavor raster set every rich receiver reads (see header). We do
  // NOT chain a `writeBuffer('public.file-url', …)` — Electron's
  // `writeBuffer` on macOS calls `[NSPasteboard clearContents]`, which
  // wipes the raster from the prior `writeImage` and leaves file-url
  // as the only flavor (sandboxed receivers like Notes then show a
  // broken-attachment placeholder). Truly-atomic multi-flavor writes
  // need a native module (`-writeObjects:` with an NSImage + NSURL),
  // which we don't ship today.
  //
  // `writeImage` on macOS is `[NSPasteboard writeObjects:@[image]]`,
  // which clears + writes atomically at the OS level — no explicit
  // `clipboard.clear()` needed, and skipping it avoids the "clipboard
  // wiped, then writeImage threw" window where the user's old
  // clipboard is gone and nothing replaced it. The try/catch below is
  // defense against a synchronous NativeImage / NSPasteboard failure
  // (memory pressure, malformed image, native-layer bug) so the IPC
  // returns a classified result instead of a raw rejection.
  try {
    // biome-ignore lint/suspicious/noExplicitAny: nativeImage.createFromBuffer returns Pick<>, writeImage wants full NativeImage — safe at runtime because Electron only reads the surface Pick<> covers.
    deps.clipboard.writeImage(img as any);
  } catch (err) {
    return {
      ok: false,
      reason: 'write-error',
      detail: (err as Error)?.message ?? 'writeImage failed',
    };
  }
  return { ok: true };
}

/**
 * Read the image bytes for `src`. Same-origin URLs (matching
 * `assetOrigin`) resolve to an on-disk path under `projectPath` and
 * read from FS — the path is canonicalized via `realpathSync` before
 * the containment check (`openAssetSafely` parity), so a symlink whose
 * lexical join stays inside the project but whose real target escapes
 * gets refused with `path-escape` rather than followed. External URLs
 * go through `fetch`.
 */
async function loadImageBytes(
  deps: CopyImageToClipboardDeps,
  src: string,
  fetchImpl: typeof fetch,
): Promise<
  | { ok: true; bytes: Buffer; ext: string }
  | { ok: false; reason: 'fetch-failed' | 'path-escape' | 'read-error'; detail?: string }
> {
  let url: URL;
  try {
    url = new URL(src);
  } catch (err) {
    return { ok: false, reason: 'fetch-failed', detail: `invalid URL: ${(err as Error).message}` };
  }
  if (url.origin === deps.assetOrigin) {
    const relPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const p = deps.platform === 'win32' ? pathWin32 : pathPosix;
    if (p.isAbsolute(relPath)) {
      return { ok: false, reason: 'path-escape', detail: `absolute rel path: ${relPath}` };
    }
    const joined = resolvePath(deps.projectPath, relPath);
    // realpath before containment — matches `resolveAndContain` in
    // asset-allowlist.ts. `isPathWithinProject` is lexical-only; a
    // symlink inside the project pointing outside it would otherwise
    // pass the containment check and `readFile` would follow it.
    const resolveCanonical = deps.resolveCanonical ?? realpathSync;
    let canonical: string;
    try {
      canonical = resolveCanonical(joined);
    } catch (err) {
      // Every `realpathSync` failure — ENOENT (path missing along the
      // chain), EACCES (permission), ELOOP (symlink cycle), or other —
      // collapses to `read-error`. The caller can distinguish causes
      // via `detail` if needed but the branch outcome (fall back to
      // renderer's own write) is the same for all of them.
      return {
        ok: false,
        reason: 'read-error',
        detail: `realpath: ${(err as Error)?.message ?? 'unknown'}`,
      };
    }
    if (!isPathWithinProject(canonical, deps.projectPath, deps.platform)) {
      return { ok: false, reason: 'path-escape', detail: `outside project: ${relPath}` };
    }
    // Extension gate — the feature is copying IMAGES; a DOM-supplied src
    // that resolves to `.ok/config.yml` or `.env` inside the project
    // should never reach `readFile`. `nativeImage.createFromBuffer` on
    // a non-image body would land on `empty-image` anyway (no raw
    // bytes escape to the clipboard), but refusing at the disk-read
    // gate is the tighter capability match and matches
    // `openAssetSafely`'s extension gate.
    //
    // Read the RAW extension here, not via `extractExt` — that helper
    // normalizes unknown extensions to `'png'` for logging + fallback
    // purposes, which would silently defeat this gate.
    const rawExt = rawExtension(canonical);
    if (!CLIPBOARD_IMAGE_EXTS.has(rawExt)) {
      return { ok: false, reason: 'path-escape', detail: `unsupported ext: .${rawExt}` };
    }
    const readFileImpl = deps.readFile ?? readFile;
    try {
      const bytes = await readFileImpl(canonical);
      return { ok: true, bytes, ext: rawExt };
    } catch (err) {
      return { ok: false, reason: 'read-error', detail: (err as Error)?.message ?? 'unknown' };
    }
  }
  // Cross-origin: fetch via the network. Node's fetch respects proxies
  // and TLS trust roots. Bounded by `AbortSignal.timeout` because the
  // renderer fire-and-forgets the call — a hanging fetch would leave
  // the user staring at a stale clipboard with no way to tell the copy
  // wedged. 10s matches the sibling `AbortSignal.timeout` pattern in
  // main/index.ts (npm-registry / cli-probe callers).
  try {
    // `redirect: 'manual'` closes the SSRF redirect-amplification
    // window — a benign external URL 3xx'ing into `169.254.169.254`
    // (cloud metadata) or `localhost:<internal-port>` would otherwise
    // follow the redirect and return the internal body. `src` is
    // DOM-supplied via authored document content, so it's
    // attacker-influenceable. `nativeImage.createFromBuffer` already
    // bounds what the bytes CAN do (only decodable rasters reach the
    // clipboard), but blocking redirects at the fetch layer is
    // zero-cost hardening on top.
    const res = await fetchImpl(src, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { ok: false, reason: 'fetch-failed', detail: `HTTP ${res.status}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, bytes: buf, ext: extractExtFromResponse(res, src) };
  } catch (err) {
    return { ok: false, reason: 'fetch-failed', detail: (err as Error)?.message ?? 'unknown' };
  }
}

/**
 * Lowercased extension of a filesystem path with no allowlist coercion —
 * `foo.YML` → `yml`, `foo` → `''`. Callers that want an image-only
 * fallback (`.txt` → `.png` for logging) can wrap this; the extension
 * gate above must NOT wrap it or it silently accepts everything.
 */
function rawExtension(path: string): string {
  const lastDot = path.lastIndexOf('.');
  if (lastDot < 0) return '';
  return path.slice(lastDot + 1).toLowerCase();
}

function extractExt(path: string): string {
  const raw = rawExtension(path);
  return raw.length > 0 && CLIPBOARD_IMAGE_EXTS.has(raw) ? raw : 'png';
}

function extractExtFromResponse(res: Response, url: string): string {
  const ct = res.headers.get('content-type') ?? '';
  const match = ct.match(/image\/([a-z0-9]+)/i);
  if (match) {
    const raw = match[1].toLowerCase();
    if (CLIPBOARD_IMAGE_EXTS.has(raw)) return raw;
    if (raw === 'jpg') return 'jpeg';
  }
  try {
    return extractExt(new URL(url).pathname);
  } catch {
    return 'png';
  }
}
