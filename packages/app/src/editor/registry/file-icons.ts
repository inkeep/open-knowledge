import type { InlineAssetMediaKind } from '@inkeep/open-knowledge-core';
import { FileText, Film, FolderOpen, Image, type LucideIcon, Volume2 } from 'lucide-react';

export interface FileIconDescriptor {
  kind?: 'folder' | 'file' | 'page' | 'document' | 'asset' | 'anchor' | 'create';
  mediaKind?: InlineAssetMediaKind | null;
  assetExt?: string | null;
}

function iconForMediaKind(mediaKind: InlineAssetMediaKind | null | undefined): LucideIcon {
  switch (mediaKind) {
    case 'image':
      return Image;
    case 'video':
      return Film;
    case 'audio':
      return Volume2;
    default:
      return FileText;
  }
}

export function mentionPathToDescriptor(path: string): FileIconDescriptor {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  const ext = dot > slash + 1 ? path.slice(dot + 1).toLowerCase() : '';
  if (ext === '') return { kind: 'folder' };
  if (ext === 'md' || ext === 'mdx') return { kind: 'page' };
  return { kind: 'asset', assetExt: ext };
}

export function getFileIcon(entry: FileIconDescriptor): LucideIcon {
  if (entry.kind === 'folder') return FolderOpen;
  if (entry.kind === 'asset') {
    if (entry.mediaKind !== undefined) return iconForMediaKind(entry.mediaKind);
    if (entry.assetExt) return iconForMediaKind(assetExtToMediaKind(entry.assetExt));
    return FileText;
  }
  return FileText;
}

function assetExtToMediaKind(ext: string): InlineAssetMediaKind | null {
  const normalized = ext.toLowerCase().replace(/^\./, '');
  if (IMAGE_EXTENSIONS.has(normalized)) return 'image';
  if (VIDEO_EXTENSIONS.has(normalized)) return 'video';
  if (AUDIO_EXTENSIONS.has(normalized)) return 'audio';
  return null;
}

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
  'bmp',
  'ico',
]);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus']);
