import {
  BUG_REPORT_ATTACHMENT_CONTENT_TYPES,
  BUG_REPORT_ATTACHMENT_EXTENSIONS,
  MAX_BUG_REPORT_ATTACHMENTS,
  MAX_BUG_REPORT_ATTACHMENTS_TOTAL_BYTES,
  type OkImageAttachmentContentType,
} from '@inkeep/open-knowledge-core';

export const MAX_IMAGE_ATTACHMENTS = MAX_BUG_REPORT_ATTACHMENTS;

export const MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES = MAX_BUG_REPORT_ATTACHMENTS_TOTAL_BYTES;

export const ACCEPTED_IMAGE_TYPES = BUG_REPORT_ATTACHMENT_CONTENT_TYPES;

export type ImageAttachmentType = OkImageAttachmentContentType;

export const IMAGE_ATTACHMENT_EXTENSIONS = BUG_REPORT_ATTACHMENT_EXTENSIONS;

export type ImageAttachmentProblem = 'count' | 'type' | 'total';

export function isImageAttachmentType(value: string): value is ImageAttachmentType {
  return (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(value);
}

export function totalImageAttachmentBytes(files: readonly File[]): number {
  return files.reduce((total, file) => total + file.size, 0);
}

export function imageAttachmentsProblem(files: readonly File[]): ImageAttachmentProblem | null {
  if (files.length > MAX_IMAGE_ATTACHMENTS) return 'count';
  if (!files.every((f) => isImageAttachmentType(f.type))) return 'type';
  if (totalImageAttachmentBytes(files) > MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES) return 'total';
  return null;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
