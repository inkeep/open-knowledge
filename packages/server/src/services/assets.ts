import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  ASSET_EXTENSIONS,
  DEFAULT_ATTACHMENT_FOLDER_PATH,
  DEFAULT_DEDUP_MODE,
  INLINE_RENDERABLE_EXTENSIONS,
  isValidAttachmentFolderPath,
  normalizeAttachmentFolderPath,
} from '@inkeep/open-knowledge-core';
import { fileTypeFromBuffer } from 'file-type';
import { toContentRelativePath } from '../asset-references.ts';
import { isWithinContentDir } from '../content-path.ts';
import { sanitizeFilename } from '../filename-sanitize.ts';
import { assertNoSymlinkEscape, isAlreadyExistsError } from '../fs-safety.ts';
import { tracedMkdirSync } from '../fs-traced.ts';
import { errnoCode } from '../http/handler-utils.ts';
import { getLogger } from '../logger.ts';
import { toPosix } from '../path-utils.ts';
import { classifyUploadErrno, UploadWriteError, type UploadWriteReason } from '../upload-errors.ts';
import { linkTempToFinalWithCollisionRetry } from '../upload-streaming.ts';
import {
  type AssetDisposition,
  assetContentTypeForPath,
  classifyAssetDisposition,
} from './asset-classification.ts';

/**
 * Domain operations for the assets capability. Transports (HTTP handlers,
 * MCP tools) parse their protocol, call these, and render the outcome;
 * every filesystem decision — canonicalization, containment, existence,
 * classification, and the upload write path — lives here exactly once.
 *
 * Outcome `reason`/`kind` values are transport-neutral; the HTTP handlers
 * own the mapping to status/URN/title (which the characterization tests pin).
 */

interface ServableAsset extends AssetDisposition {
  canonicalPath: string;
  relativePath: string;
  size: number;
  contentType: string;
}

type ServeResolution =
  | { ok: true; asset: ServableAsset }
  | {
      ok: false;
      reason: 'missing-path' | 'unsupported-type' | 'not-found' | 'invalid-path';
      /** Underlying fs error, when one produced the failure — log-only, never on the wire. */
      cause?: unknown;
    };

type TextResolution =
  | { ok: true; canonicalPath: string; size: number }
  | { ok: false; reason: 'missing-path' | 'not-found' | 'invalid-path'; cause?: unknown };

interface StoreUploadInput {
  /** Streamed multipart tempfile (the transport's `readUploadBody` output). */
  tempPath: string;
  /** sha256 hex of the tempfile bytes, from the streaming hash pass. */
  sha: string;
  byteLength: number;
  /** Client-supplied filename; may be a generic clipboard name. */
  filename: string;
  /** Schema-validated, escape-checked by the transport before the call. */
  parentDocName: string;
  placement: 'configured-attachments' | 'parent-dir' | undefined;
}

type StoreUploadOutcome =
  | { ok: true; src: string; path: string; deduped: boolean; mime: string | null }
  | { ok: false; kind: 'config-error'; cause: unknown }
  | { ok: false; kind: 'invalid-attachment-folder' }
  | { ok: false; kind: 'path-escape'; cause?: unknown }
  | { ok: false; kind: 'dest-validation-error'; cause: unknown; destDir: string }
  | { ok: false; kind: 'mkdir-failed'; reason: UploadWriteReason; cause: unknown }
  | {
      ok: false;
      kind: 'write-failed';
      reason: UploadWriteReason;
      cause: unknown;
      filename: string;
    };

export interface AssetService {
  /** `/api/asset` domain: extension-gated, ignore-filtered, classified for serving. */
  resolveServableAsset(requestedPath: string | null): ServeResolution;
  /**
   * `/api/asset-text` domain: same containment core, deliberately NO
   * extension gate and NO ignore filter — the caller reaches this only for
   * files it can already see, and blocking here would break the
   * read-a-hidden-file workflow. Path safety stays load-bearing.
   */
  resolveTextAsset(requestedPath: string | null): TextResolution;
  /**
   * `/api/upload` write path: attachment-folder resolution, containment and
   * symlink-escape enforcement around directory creation, magic-byte sniff,
   * same-dir sha256 dedup, filename synthesis, and the tempfile→final link.
   * Owns the tempfile: every failure path unlinks it; success consumes it.
   */
  storeUpload(input: StoreUploadInput): Promise<StoreUploadOutcome>;
}

export interface AssetServiceDeps {
  contentDir: string;
  /** Ignore filter for the servable path; text resolution never consults it. */
  isPathIgnored?: (relativePath: string) => boolean;
  /** Fresh-read `content.attachmentFolderPath` accessor; may throw on invalid config. */
  getAttachmentFolderPath?: () => string;
}

type CanonicalResolution =
  | { ok: true; canonicalPath: string; relativePath: string; size: number }
  | { ok: false; reason: 'not-found' | 'invalid-path'; cause?: unknown };

const GENERIC_PASTE_NAMES = /^(image\.(png|jpe?g|gif|webp)|Clipboard.*|Untitled.*)$/i;

/**
 * Resolve the destination directory for an upload from the parent doc's
 * path and the configured `content.attachmentFolderPath`. Matches Obsidian's
 * literal schema (free-form string):
 *
 *   - `"./"` (default)  → same directory as the doc
 *   - `"/"`             → content-directory root
 *   - `"./<sub>"`       → subdirectory beside the doc
 *   - `"<name>"` (bare) → fixed content-relative path
 *
 * Treats any `./` prefix as "relative to doc dir," any other value as
 * "relative to content dir." Empty or whitespace-only strings fall back
 * to the default (doc dir).
 *
 * Returns an absolute path within `resolvedContentDir` — path-escape
 * enforcement happens at the caller via `isWithinContentDir` + `realpath`.
 */
export function resolveUploadDestDir(
  parentDocName: string,
  attachmentFolderPath: string,
  resolvedContentDir: string,
): string {
  const trimmed = attachmentFolderPath.trim();
  if (trimmed === '' || trimmed === './') {
    return resolve(resolvedContentDir, dirname(parentDocName));
  }
  if (trimmed === '/') {
    return resolvedContentDir;
  }
  if (trimmed.startsWith('./')) {
    // Subdirectory beside the doc. `"./attachments"` → `<docDir>/attachments`.
    return resolve(resolvedContentDir, dirname(parentDocName), trimmed.slice(2));
  }
  // Bare name or nested path: fixed content-relative location.
  return resolve(resolvedContentDir, trimmed);
}

/**
 * Read at most `n` bytes from the start of `path`. Feeds both the magic-byte
 * sniff (`fileTypeFromBuffer` over the head) and the SVG text fallback
 * (`file-type` can't detect text-based SVG), without ever materializing the
 * whole file.
 */
function readTempFileHead(path: string, n: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/**
 * Upper bound on size-matched candidates we'll read+hash in a single
 * dedup call. A capture-device folder with 1000+ screenshots at the same
 * resolution could theoretically produce that many same-size siblings;
 * each candidate costs a sync readFileSync + sha256Hex of the entire
 * buffer, which would block the event loop for seconds per upload under
 * adversarial / pathological load.
 *
 * Past the bound, dedup degrades to best-effort: we log a structured
 * WARN and return null (treat as no-match → write a new file with the
 * collision-suffix loop). This is a bounded-resource defense, not a
 * correctness change — a duplicate that slips through produces the
 * cheap storage cost of one extra on-disk copy, not silent data loss.
 * The O(1) hash-cache alternative is a
 * larger architectural change and a follow-on.
 */
const MAX_DEDUP_SCAN_CANDIDATES = 1000;

/**
 * Stream a file's bytes through a sha256 Hash transform and return the hex
 * digest. Keeps memory O(1) regardless of file size — a 500 MB candidate
 * read by the buffer-based `readFileSync` path would otherwise materialize
 * the whole file in heap, which defeats the streaming-upload amendment's
 * O(1) memory guarantee.
 *
 * Throws on read errors so the caller can classify ENOENT (concurrent
 * rename — stay silent) vs other errors (log and skip).
 */
async function streamingHashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/**
 * Scan `destDir` non-recursively for an existing file whose sha256 matches
 * the buffer's. Returns the matching basename (case-preserving) or null if
 * no match. Bounded by directory size — O(n) in sibling count, not vault size.
 * Only files with extensions in ASSET_EXTENSIONS are candidates; everything
 * else (markdown, .git/, etc.) is skipped.
 *
 * `expectedSize` is the buffer's byte length — passed in so we can size-
 * prefilter before hashing siblings. sha256 collision requires equal-sized
 * inputs, so same-extension siblings with a different size are not
 * candidates and we skip their (potentially multi-MB) read.
 */
async function findDuplicateAsset(
  destDir: string,
  sha: string,
  expectedSize: number,
): Promise<string | null> {
  let entries: string[];
  try {
    // Async `readdir` so the directory walk doesn't block the event
    // loop during uploads — Node's event loop is shared with WebSocket sync
    // and CRDT updates, and a 1k-entry walk is observable on bursty
    // upload traffic. The MAX_DEDUP_SCAN_CANDIDATES cap
    // bounds the worst case at 1000 same-size siblings, but the
    // pre-cap entry list can still be much larger.
    entries = await readdir(destDir);
  } catch {
    return null;
  }
  const log = getLogger('upload');
  let scanned = 0;
  for (const entry of entries) {
    const ext = extname(entry).slice(1).toLowerCase();
    if (!ASSET_EXTENSIONS.has(ext)) continue;
    const fullPath = resolve(destDir, entry);
    let entryStat: Awaited<ReturnType<typeof stat>>;
    try {
      entryStat = await stat(fullPath);
    } catch {
      continue;
    }
    if (!entryStat.isFile() || entryStat.size !== expectedSize) continue;
    // Bounded scan: only count candidates that passed the cheap size
    // prefilter, since same-size siblings are the ones that cost a
    // full-file hash each (streaming now, not buffered).
    scanned++;
    if (scanned > MAX_DEDUP_SCAN_CANDIDATES) {
      log.warn(
        {
          event: 'upload-dedup-skip',
          reason: 'scan-cap-exceeded',
          destDir,
          scanned: MAX_DEDUP_SCAN_CANDIDATES,
          expectedSize,
        },
        `[upload-dedup] candidate scan exceeded ${MAX_DEDUP_SCAN_CANDIDATES} same-size siblings — degrading to no-dedup for this upload`,
      );
      return null;
    }
    let candidateSha: string;
    try {
      // Stream + hash the candidate to preserve the O(1) memory guarantee
      // the upload pipeline otherwise maintains end-to-end. A 500 MB
      // candidate otherwise spiked heap to 500 MB per scan.
      candidateSha = await streamingHashFile(fullPath);
    } catch (err) {
      const code = errnoCode(err);
      // ENOENT is the legitimate concurrent-rename race — stay silent.
      if (code !== 'ENOENT') {
        log.warn(
          { event: 'upload-dedup-skip', reason: 'read-failed', code, entry },
          '[upload-dedup] skipped candidate — read failed',
        );
      }
      continue;
    }
    if (candidateSha === sha) return entry;
  }
  return null;
}

export function createAssetService(deps: AssetServiceDeps): AssetService {
  /**
   * The shared containment core: resolve against the realpath'd content
   * root, canonicalize, verify containment, require a regular file, and
   * reject any spelling that is not already canonical (traversal segments,
   * backslashes) even when it stays inside the root.
   */
  function resolveCanonical(assetPath: string): CanonicalResolution {
    const resolvedContentDir = realpathSync(deps.contentDir);
    const requestedPath = resolve(resolvedContentDir, assetPath);
    let canonicalPath: string;
    try {
      canonicalPath = realpathSync(requestedPath);
    } catch (err) {
      return { ok: false, reason: 'not-found', cause: err };
    }
    if (!isWithinContentDir(canonicalPath, resolvedContentDir)) {
      return { ok: false, reason: 'invalid-path' };
    }
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(canonicalPath);
    } catch (err) {
      return { ok: false, reason: 'not-found', cause: err };
    }
    if (!stat.isFile()) {
      return { ok: false, reason: 'not-found' };
    }
    const relativePath = toContentRelativePath(resolvedContentDir, canonicalPath);
    if (relativePath !== assetPath.split('\\').join('/')) {
      return { ok: false, reason: 'invalid-path' };
    }
    return { ok: true, canonicalPath, relativePath, size: stat.size };
  }

  async function storeUpload(input: StoreUploadInput): Promise<StoreUploadOutcome> {
    const { tempPath, sha, byteLength, filename, parentDocName, placement } = input;

    // Belt-and-braces cleanup: every failure path below that does NOT
    // consume the tempfile via linkTempToFinal* runs this.
    const cleanupTempfile = () => {
      if (existsSync(tempPath)) {
        try {
          unlinkSync(tempPath);
        } catch {
          // best-effort; orphan sweep reaps stragglers
        }
      }
    };

    const resolvedContentDir = resolve(deps.contentDir);
    let rawAttachmentFolderPath: string;
    try {
      rawAttachmentFolderPath =
        placement === 'parent-dir'
          ? DEFAULT_ATTACHMENT_FOLDER_PATH
          : (deps.getAttachmentFolderPath?.() ?? DEFAULT_ATTACHMENT_FOLDER_PATH);
    } catch (err) {
      cleanupTempfile();
      return { ok: false, kind: 'config-error', cause: err };
    }
    if (!isValidAttachmentFolderPath(rawAttachmentFolderPath)) {
      cleanupTempfile();
      return { ok: false, kind: 'invalid-attachment-folder' };
    }
    const attachmentFolderPath = normalizeAttachmentFolderPath(rawAttachmentFolderPath);
    const destDir = resolveUploadDestDir(parentDocName, attachmentFolderPath, resolvedContentDir);
    if (!isWithinContentDir(destDir, resolvedContentDir)) {
      cleanupTempfile();
      return { ok: false, kind: 'path-escape' };
    }
    // Pre-mkdir symlink-escape check: walks up from destDir to the
    // deepest existing ancestor and rejects if its realpath escapes contentDir.
    // Doing this before `tracedMkdirSync({ recursive: true })` prevents mkdir from
    // following a parent symlink and materializing a fresh directory outside
    // contentDir. The post-mkdir realpath check below remains as defense-in-
    // depth against TOCTOU symlink-replace races between this check and mkdir.
    try {
      assertNoSymlinkEscape(destDir, resolvedContentDir);
    } catch (err) {
      cleanupTempfile();
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('symlink-escape:')) {
        return { ok: false, kind: 'path-escape' };
      }
      return { ok: false, kind: 'dest-validation-error', cause: err, destDir };
    }
    // mkdir -p the destination — bare-name / nested attachmentFolderPath
    // values produce directories that may not exist at first upload.
    try {
      tracedMkdirSync(destDir, { recursive: true });
    } catch (err) {
      if (!isAlreadyExistsError(err)) {
        cleanupTempfile();
        // Classify the errno through the same typed table the streaming-
        // write path uses so ENOSPC/EDQUOT route through 507 storage-full
        // and EROFS/EACCES/EPERM route through 500 storage-readonly —
        // SDK consumers branch on the URN, not the errno.
        const reason = classifyUploadErrno(err as NodeJS.ErrnoException);
        return { ok: false, kind: 'mkdir-failed', reason, cause: err };
      }
    }

    // Symlink escape check: realpath the dest dir and compare against realpath'd contentDir
    try {
      const realDestDir = realpathSync(destDir);
      let realContentDir: string;
      try {
        realContentDir = realpathSync(resolvedContentDir);
      } catch {
        realContentDir = resolvedContentDir;
      }
      if (!isWithinContentDir(realDestDir, realContentDir)) {
        cleanupTempfile();
        return { ok: false, kind: 'path-escape' };
      }
    } catch (e) {
      const code = errnoCode(e);
      if (code === 'ENOENT') {
        // Directory doesn't exist yet — will be created below; no symlink escape possible
      } else {
        cleanupTempfile();
        return { ok: false, kind: 'path-escape', cause: e };
      }
    }

    // Accept-all: every file is accepted — there's no user-facing byte cap
    // post-streaming (disk fullness surfaces as 507 instead). The magic-
    // byte sniff is only consulted to (a) preserve the SVG `<img>`-only
    // routing for security and (b) recover an extension when the upload
    // arrived with a generic clipboard filename. Non-sniffable bytes are
    // accepted under the client-supplied filename.
    const SNIFF_HEAD_BYTES = 4100;
    const head = readTempFileHead(tempPath, SNIFF_HEAD_BYTES);
    const fileTypeResult = await fileTypeFromBuffer(head);
    let detectedMime: string | undefined = fileTypeResult?.mime;
    let detectedExt: string | undefined = fileTypeResult?.ext;
    // file-type can't detect SVG (text-based, no magic bytes) — check manually.
    // STOP: this fallback is LOAD-BEARING — SVG must render via
    // <img>, never inline DOM. Do not remove without a compensating guard.
    if (!detectedMime) {
      // Strip a leading UTF-8 BOM (U+FEFF) before the pattern match.
      // `trimStart()` removes ECMAScript whitespace but not the BOM, so a
      // file starting with `\xEF\xBB\xBF<svg ...>` would otherwise evade the
      // head check the comment above documents as the SVG-disguised-as-PNG
      const headText = head.subarray(0, 256).toString('utf-8').replace(/^﻿/, '').trimStart();
      if (
        headText.startsWith('<svg') ||
        (headText.startsWith('<?xml') && headText.includes('<svg'))
      ) {
        detectedMime = 'image/svg+xml';
        detectedExt = 'svg';
      }
    }

    // Same-dir sha256 dedup. Bounded scan over destDir, skipped entirely
    // when DEFAULT_DEDUP_MODE === 'off'. The dedup test happens BEFORE
    // filename synthesis so a duplicate paste preserves the existing
    // on-disk basename instead of producing a fresh pasted-<ts>.png stub.
    //
    // On a dedup hit the tempfile is unlinked and we short-circuit without
    // touching the destDir inode — `linkTempToFinalWithCollisionRetry`
    // never runs.
    if (DEFAULT_DEDUP_MODE === 'same-dir') {
      const existing = await findDuplicateAsset(destDir, sha, byteLength);
      if (existing) {
        cleanupTempfile();
        const relPath = toPosix(relative(deps.contentDir, resolve(destDir, existing)));
        return {
          ok: true,
          src: existing,
          path: relPath,
          deduped: true,
          mime: detectedMime ?? null,
        };
      }
    }

    // GENERIC_PASTE_NAMES: clipboard paste arrives with synthetic names
    // ("image.png", "Clipboard 2024-04-21 14:23:45"). Replace with a
    // timestamp stem so the disk filename is human-meaningful.
    let finalFilename: string;
    const isGenericPaste = !filename || filename === 'upload' || GENERIC_PASTE_NAMES.test(filename);
    if (isGenericPaste) {
      const now = new Date();
      const ts = now
        .toISOString()
        .replace(/[-:T]/g, '')
        .slice(0, 14)
        .replace(/(\d{8})(\d{6})/, '$1-$2');
      // Prefer the sniffed extension when present; otherwise try the
      // client-supplied extname, finally fall back to .bin.
      const fallbackExt = filename ? extname(filename).slice(1) : '';
      const ext = detectedExt ?? fallbackExt ?? '';
      finalFilename = ext === '' ? `pasted-${ts}` : `pasted-${ts}.${ext}`;
    } else {
      finalFilename = sanitizeFilename(filename);
    }

    try {
      const destFilename = linkTempToFinalWithCollisionRetry(tempPath, destDir, finalFilename);
      const relPath = toPosix(relative(deps.contentDir, resolve(destDir, destFilename)));
      return {
        ok: true,
        src: destFilename,
        path: relPath,
        deduped: false,
        mime: detectedMime ?? null,
      };
    } catch (e) {
      // linkTempToFinalWithCollisionRetry best-effort unlinks the tempfile
      // on throw; no extra cleanupTempfile() call needed here.
      const reason: UploadWriteReason =
        e instanceof UploadWriteError ? e.reason : 'urn:ok:error:storage-error';
      return { ok: false, kind: 'write-failed', reason, cause: e, filename: finalFilename };
    }
  }

  return {
    resolveServableAsset(requestedPath) {
      if (!requestedPath || requestedPath.includes('\0')) {
        return { ok: false, reason: 'missing-path' };
      }
      const contentType = assetContentTypeForPath(requestedPath);
      const ext = extname(requestedPath).slice(1).toLowerCase();
      if (!contentType || !ASSET_EXTENSIONS.has(ext)) {
        return { ok: false, reason: 'unsupported-type' };
      }
      const core = resolveCanonical(requestedPath);
      if (!core.ok) return core;
      // Ignore-filter AFTER containment, reported as not-found: exclusion is
      // opaque on the wire, identical to a missing file.
      if (deps.isPathIgnored?.(core.relativePath)) {
        return { ok: false, reason: 'not-found' };
      }
      return {
        ok: true,
        asset: {
          canonicalPath: core.canonicalPath,
          relativePath: core.relativePath,
          size: core.size,
          contentType,
          ...classifyAssetDisposition(ext, INLINE_RENDERABLE_EXTENSIONS),
        },
      };
    },

    resolveTextAsset(requestedPath) {
      if (!requestedPath || requestedPath.includes('\0')) {
        return { ok: false, reason: 'missing-path' };
      }
      const core = resolveCanonical(requestedPath);
      if (!core.ok) return core;
      return { ok: true, canonicalPath: core.canonicalPath, size: core.size };
    },

    storeUpload,
  };
}
