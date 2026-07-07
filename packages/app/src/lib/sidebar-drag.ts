import type { InlineAssetMediaKind } from '@inkeep/open-knowledge-core';
import {
  largeFileNavigationTarget,
  type ResolvedNavigationTarget,
} from '@/components/navigation-targets';
import { hashFromAssetPath, hashFromDocName, hashFromFolderPath } from '@/lib/doc-hash';

export const OK_SIDEBAR_DRAG_MIME = 'application/x-open-knowledge-sidebar-item+json';

export type SidebarDragPayload =
  | { v: 1; kind: 'doc'; docName: string; size: number | null }
  | { v: 1; kind: 'folder'; folderPath: string }
  | { v: 1; kind: 'asset'; assetPath: string; mediaKind: InlineAssetMediaKind | null };

// Drift warning: keep exhaustive with InlineAssetMediaKind in core upload constants.
const INLINE_ASSET_MEDIA_KIND_VALUES = {
  image: true,
  video: true,
  audio: true,
  pdf: true,
  text: true,
} satisfies Record<InlineAssetMediaKind, true>;

export function serializeSidebarDragPayload(payload: SidebarDragPayload): string {
  return JSON.stringify(payload);
}

export function navigationForSidebarDragPayload(payload: SidebarDragPayload): {
  target: ResolvedNavigationTarget;
  hash: string;
} {
  if (payload.kind === 'folder') {
    return {
      target: { kind: 'folder', target: payload.folderPath, folderPath: payload.folderPath },
      hash: hashFromFolderPath(payload.folderPath),
    };
  }
  if (payload.kind === 'asset') {
    return {
      target: {
        kind: 'asset',
        target: payload.assetPath,
        assetPath: payload.assetPath,
        mediaKind: payload.mediaKind,
      },
      hash: hashFromAssetPath(payload.assetPath),
    };
  }
  return {
    target: largeFileNavigationTarget(payload.docName, payload.size) ?? {
      kind: 'doc',
      target: payload.docName,
      docName: payload.docName,
    },
    hash: hashFromDocName(payload.docName),
  };
}

export function parseSidebarDragPayload(
  dataTransfer: Pick<DataTransfer, 'types' | 'getData'> | null | undefined,
): SidebarDragPayload | null {
  if (!dataTransfer) return null;
  const types = Array.from(dataTransfer.types);
  if (!types.includes(OK_SIDEBAR_DRAG_MIME)) return null;

  const raw = dataTransfer.getData(OK_SIDEBAR_DRAG_MIME);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.kind !== 'string') return null;

  if (parsed.kind === 'doc') {
    if (typeof parsed.docName !== 'string' || parsed.docName.length === 0) return null;
    const size = parsed.size;
    if (size !== null && typeof size !== 'number') return null;
    return { v: 1, kind: 'doc', docName: parsed.docName, size };
  }

  if (parsed.kind === 'folder') {
    if (typeof parsed.folderPath !== 'string') return null;
    return { v: 1, kind: 'folder', folderPath: parsed.folderPath };
  }

  if (parsed.kind === 'asset') {
    if (typeof parsed.assetPath !== 'string' || parsed.assetPath.length === 0) return null;
    const mediaKind = parsed.mediaKind;
    if (mediaKind !== null && !isInlineAssetMediaKind(mediaKind)) return null;
    return { v: 1, kind: 'asset', assetPath: parsed.assetPath, mediaKind };
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInlineAssetMediaKind(value: unknown): value is InlineAssetMediaKind {
  return typeof value === 'string' && Object.hasOwn(INLINE_ASSET_MEDIA_KIND_VALUES, value);
}
