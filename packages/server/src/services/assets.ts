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
import { isReservedProjectStatePath } from '../content/managed-doc-enum.ts';
import { isWithinContentDir } from '../content-path.ts';
import { sanitizeFilename } from '../filename-sanitize.ts';
import {
  assertNoSymlinkEscape,
  canonicalRelPathForNewTarget,
  isAlreadyExistsError,
  isContainmentRejection,
} from '../fs-safety.ts';
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
      cause?: unknown;
    };

type TextResolution =
  | { ok: true; canonicalPath: string; size: number }
  | { ok: false; reason: 'missing-path' | 'not-found' | 'invalid-path'; cause?: unknown };

interface StoreUploadInput {
  tempPath: string;
  sha: string;
  byteLength: number;
  filename: string;
  parentDocName: string;
  placement: 'configured-attachments' | 'parent-dir' | undefined;
}

type StoreUploadOutcome =
  | { ok: true; src: string; path: string; deduped: boolean; mime: string | null }
  | { ok: false; kind: 'config-error'; cause: unknown }
  | { ok: false; kind: 'invalid-attachment-folder' }
  | { ok: false; kind: 'path-escape'; cause?: unknown }
  | { ok: false; kind: 'dest-validation-error'; cause: unknown; destDir: string }
  | { ok: false; kind: 'reserved-destination'; destDir: string }
  | { ok: false; kind: 'mkdir-failed'; reason: UploadWriteReason; cause: unknown }
  | {
      ok: false;
      kind: 'write-failed';
      reason: UploadWriteReason;
      cause: unknown;
      filename: string;
    };

export interface AssetService {
  resolveServableAsset(requestedPath: string | null): ServeResolution;
  resolveTextAsset(requestedPath: string | null): TextResolution;
  storeUpload(input: StoreUploadInput): Promise<StoreUploadOutcome>;
}

export interface AssetServiceDeps {
  contentDir: string;
  isPathIgnored?: (relativePath: string) => boolean;
  getAttachmentFolderPath?: () => string;
}

type CanonicalResolution =
  | { ok: true; canonicalPath: string; relativePath: string; size: number }
  | { ok: false; reason: 'not-found' | 'invalid-path'; cause?: unknown };

const GENERIC_PASTE_NAMES = /^(image\.(png|jpe?g|gif|webp)|Clipboard.*|Untitled.*)$/i;

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
    return resolve(resolvedContentDir, dirname(parentDocName), trimmed.slice(2));
  }
  return resolve(resolvedContentDir, trimmed);
}

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

const MAX_DEDUP_SCAN_CANDIDATES = 1000;

async function streamingHashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function findDuplicateAsset(
  destDir: string,
  sha: string,
  expectedSize: number,
): Promise<string | null> {
  let entries: string[];
  try {
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
      candidateSha = await streamingHashFile(fullPath);
    } catch (err) {
      const code = errnoCode(err);
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

    const cleanupTempfile = () => {
      if (existsSync(tempPath)) {
        try {
          unlinkSync(tempPath);
        } catch {}
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
    try {
      assertNoSymlinkEscape(destDir, resolvedContentDir);
    } catch (err) {
      cleanupTempfile();
      if (isContainmentRejection(err)) {
        return { ok: false, kind: 'path-escape' };
      }
      return { ok: false, kind: 'dest-validation-error', cause: err, destDir };
    }
    const canonicalDestRel = canonicalRelPathForNewTarget(
      destDir,
      resolvedContentDir,
      getLogger('upload'),
    );
    if (isReservedProjectStatePath(canonicalDestRel)) {
      cleanupTempfile();
      return { ok: false, kind: 'reserved-destination', destDir };
    }
    try {
      tracedMkdirSync(destDir, { recursive: true });
    } catch (err) {
      if (!isAlreadyExistsError(err)) {
        cleanupTempfile();
        const reason = classifyUploadErrno(err as NodeJS.ErrnoException);
        return { ok: false, kind: 'mkdir-failed', reason, cause: err };
      }
    }

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
      if (isReservedProjectStatePath(toPosix(relative(realContentDir, realDestDir)))) {
        cleanupTempfile();
        return { ok: false, kind: 'reserved-destination', destDir };
      }
    } catch (e) {
      const code = errnoCode(e);
      if (code === 'ENOENT') {
      } else {
        cleanupTempfile();
        return { ok: false, kind: 'path-escape', cause: e };
      }
    }

    const SNIFF_HEAD_BYTES = 4100;
    const head = readTempFileHead(tempPath, SNIFF_HEAD_BYTES);
    const fileTypeResult = await fileTypeFromBuffer(head);
    let detectedMime: string | undefined = fileTypeResult?.mime;
    let detectedExt: string | undefined = fileTypeResult?.ext;
    /*
     * STOP: this fallback is LOAD-BEARING — SVG must render via
     * <img>, never inline DOM. Do not remove without a compensating guard.
     */
    if (!detectedMime) {
      const headText = head.subarray(0, 256).toString('utf-8').replace(/^﻿/, '').trimStart();
      if (
        headText.startsWith('<svg') ||
        (headText.startsWith('<?xml') && headText.includes('<svg'))
      ) {
        detectedMime = 'image/svg+xml';
        detectedExt = 'svg';
      }
    }

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

    let finalFilename: string;
    const isGenericPaste = !filename || filename === 'upload' || GENERIC_PASTE_NAMES.test(filename);
    if (isGenericPaste) {
      const now = new Date();
      const ts = now
        .toISOString()
        .replace(/[-:T]/g, '')
        .slice(0, 14)
        .replace(/(\d{8})(\d{6})/, '$1-$2');
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
