import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import * as pathPosix from 'node:path/posix';
import * as pathWin32 from 'node:path/win32';
import type { Clipboard, NativeImage } from 'electron';
import { isPathWithinProject } from './ipc-handlers.ts';

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
  readonly assetOrigin: string;
  readonly clipboard: Pick<Clipboard, 'writeImage'>;
  readonly nativeImage: {
    createFromBuffer(buffer: Buffer): Pick<NativeImage, 'isEmpty'>;
  };
  readonly fetch?: typeof fetch;
  readonly resolveCanonical?: (path: string) => string;
  readonly readFile?: (path: string) => Promise<Buffer>;
}

export interface CopyImageInput {
  readonly src: string;
  readonly alt: string;
}

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
    const resolveCanonical = deps.resolveCanonical ?? realpathSync;
    let canonical: string;
    try {
      canonical = resolveCanonical(joined);
    } catch (err) {
      return {
        ok: false,
        reason: 'read-error',
        detail: `realpath: ${(err as Error)?.message ?? 'unknown'}`,
      };
    }
    if (!isPathWithinProject(canonical, deps.projectPath, deps.platform)) {
      return { ok: false, reason: 'path-escape', detail: `outside project: ${relPath}` };
    }
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
  try {
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
