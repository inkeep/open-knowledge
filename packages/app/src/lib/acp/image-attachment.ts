import {
  type AttachmentPart,
  isTextishMime,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { i18n } from '@lingui/core';
import { plural, t } from '@lingui/core/macro';
import { formatToolList } from '@/lib/tool-list-format';

export const ALLOWED_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const EMBEDDED_ATTACHMENT_BYTE_LIMIT = 700 * 1024;

export const MAX_IMAGE_BYTES = EMBEDDED_ATTACHMENT_BYTE_LIMIT;

export const MAX_EMBEDDED_FILE_BYTES = EMBEDDED_ATTACHMENT_BYTE_LIMIT;

export const MAX_TOTAL_ATTACHMENT_BYTES = EMBEDDED_ATTACHMENT_BYTE_LIMIT;

const NAMED_REFUSED_FILES = 3;

export function embeddedAttachmentBytes(part: AttachmentPart): number {
  if (part.kind !== 'image' && part.kind !== 'blob') return 0;
  return part.sizeBytes ?? part.data.length;
}

export function totalEmbeddedAttachmentBytes(parts: readonly AttachmentPart[]): number {
  return parts.reduce((sum, part) => sum + embeddedAttachmentBytes(part), 0);
}

export function attachmentBudgetKb(): number {
  return Math.round(MAX_TOTAL_ATTACHMENT_BYTES / 1024);
}

type RefusedFileLocation = 'outside-project' | 'unknown';

export type AttachmentRefusal =
  | {
      readonly kind: 'file-too-large';
      readonly name: string;
      readonly location: RefusedFileLocation;
      readonly limitBytes: number;
    }
  | { readonly kind: 'not-text'; readonly name: string; readonly location: RefusedFileLocation };

export type ImageAttachmentError =
  | { readonly kind: 'unsupported-type'; readonly mimeType: string }
  | { readonly kind: 'too-large'; readonly sizeBytes: number; readonly limitBytes: number }
  | AttachmentRefusal;

export type FileAttachmentError = ImageAttachmentError;

const IS_REFUSAL: {
  readonly [K in ImageAttachmentError['kind']]: K extends AttachmentRefusal['kind'] ? true : false;
} = {
  'unsupported-type': false,
  'too-large': false,
  'file-too-large': true,
  'not-text': true,
};

export function isAttachmentRefusal(error: ImageAttachmentError): error is AttachmentRefusal {
  return IS_REFUSAL[error.kind];
}

function assertNeverAttachmentError(error: never): never {
  throw new Error(`Unhandled attachment error: ${JSON.stringify(error)}`);
}

export function describeImageError(error: ImageAttachmentError): string {
  switch (error.kind) {
    case 'unsupported-type': {
      const mimeType = error.mimeType;
      if (mimeType.startsWith('image/')) {
        return t`Only PNG, JPEG, GIF, and WebP images are supported (got ${mimeType}).`;
      }
      const fileType = mimeType || 'unknown';
      return t`Unsupported file type: ${fileType}.`;
    }
    case 'too-large': {
      const limitKb = Math.round(error.limitBytes / 1024);
      const sizeKb = Math.round(error.sizeBytes / 1024);
      return t`File is too large (${sizeKb} KB) — each attachment is capped at ${limitKb} KB. Crop or resize it and try again.`;
    }
    case 'file-too-large':
    case 'not-text':
      return describeRefusedFiles(error, [error.name]);
    default:
      return assertNeverAttachmentError(error);
  }
}

function refusedFileNames(names: readonly string[]): string {
  const locale = i18n.locale;
  if (names.length <= NAMED_REFUSED_FILES) return formatToolList(names, locale);
  const shown = names.slice(0, NAMED_REFUSED_FILES - 1);
  const others = names.length - shown.length;
  return formatToolList(
    [...shown, t`${plural(others, { one: '# other', other: '# others' })}`],
    locale,
  );
}

function describeRefusedFiles(first: AttachmentRefusal, names: readonly string[]): string {
  const count = names.length;
  const files = refusedFileNames(names);
  if (first.kind === 'not-text') {
    if (first.location === 'outside-project') {
      return t`${plural(count, {
        one: `${files} isn't a text file, so it can't be sent with the message. Add it to your project, then mention it with @.`,
        other: `${files} aren't text files, so they can't be sent with the message. Add them to your project, then mention them with @.`,
      })}`;
    }
    return t`${plural(count, {
      one: `${files} isn't a text file, so it can't be sent with the message. Mention it with @ once it's in your project.`,
      other: `${files} aren't text files, so they can't be sent with the message. Mention them with @ once they're in your project.`,
    })}`;
  }
  const capKb = Math.round(first.limitBytes / 1024);
  if (first.location === 'outside-project') {
    return t`${plural(count, {
      one: `${files} is larger than ${capKb} KB, so it can't be sent with the message. Add it to your project, then mention it with @.`,
      other: `${files} are each larger than ${capKb} KB, so they can't be sent with the message. Add them to your project, then mention them with @.`,
    })}`;
  }
  return t`${plural(count, {
    one: `${files} is larger than ${capKb} KB, so it can't be sent with the message. Mention it with @ once it's in your project.`,
    other: `${files} are each larger than ${capKb} KB, so they can't be sent with the message. Mention them with @ once they're in your project.`,
  })}`;
}

export function describeAttachmentRefusals(refusals: readonly AttachmentRefusal[]): string[] {
  const groups = new Map<string, { first: AttachmentRefusal; names: string[] }>();
  for (const refusal of refusals) {
    const key = `${refusal.kind}:${refusal.location}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { first: refusal, names: [refusal.name] });
    else group.names.push(refusal.name);
  }
  return [...groups.values()].map(({ first, names }) => describeRefusedFiles(first, names));
}

async function base64Of(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string result'));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(blob);
  });
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

const RESIZE_MAX_EDGE = 2048;

const RESIZE_MIN_EDGE = 512;

const RESIZE_ATTEMPTS = 6;

const RESIZE_QUALITY = 0.85;

export interface ShrunkImage {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
}

export type ImageShrinker = (file: File, limits: readonly number[]) => Promise<ShrunkImage | null>;

export async function fitImageToBytes(
  size: { readonly width: number; readonly height: number },
  maxBytes: number,
  encode: (width: number, height: number) => Promise<Blob>,
): Promise<ShrunkImage | null> {
  const longEdge = Math.max(size.width, size.height);
  const smallestEdge = Math.min(RESIZE_MIN_EDGE, longEdge);
  let scale = Math.min(1, RESIZE_MAX_EDGE / longEdge);
  for (let attempt = 0; attempt < RESIZE_ATTEMPTS; attempt += 1) {
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    if (Math.max(width, height) < smallestEdge) return null;
    const blob = await encode(width, height);
    if (blob.size <= maxBytes) return { blob, width, height };
    scale *= Math.sqrt(maxBytes / blob.size) * 0.9;
  }
  return null;
}

async function encodeScaled(bitmap: ImageBitmap, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('OffscreenCanvas has no 2d context');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, width, height);
  const webp = await canvas.convertToBlob({ type: 'image/webp', quality: RESIZE_QUALITY });
  if (webp.type === 'image/webp') return webp;
  context.globalCompositeOperation = 'destination-over';
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: RESIZE_QUALITY });
}

async function fitBitmapToFirstLimit(
  bitmap: ImageBitmap,
  limits: readonly number[],
): Promise<ShrunkImage | null> {
  for (const maxBytes of limits) {
    const fitted = await fitImageToBytes(bitmap, maxBytes, (width, height) =>
      encodeScaled(bitmap, width, height),
    );
    if (fitted !== null) return fitted;
  }
  return null;
}

export const shrinkImageToFit: ImageShrinker = async (file, limits) => {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    return null;
  }
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    return await fitBitmapToFirstLimit(bitmap, limits);
  } catch (error) {
    console.warn(
      '[acp-attachment] could not resize an image',
      { sizeBytes: file.size, mimeType: file.type || '' },
      error,
    );
    return null;
  } finally {
    bitmap?.close();
  }
};

export interface ImageAttachmentOptions {
  readonly budgetBytes?: number | undefined;
  readonly shrink?: ImageShrinker;
}

export async function fileToImageAttachment(
  file: File,
  options: ImageAttachmentOptions = {},
): Promise<
  | { readonly ok: true; readonly part: AttachmentPart }
  | { readonly ok: false; readonly error: ImageAttachmentError }
> {
  const mimeType = file.type || '';
  if (!ALLOWED_IMAGE_MIMES.has(mimeType)) {
    return { ok: false, error: { kind: 'unsupported-type', mimeType } };
  }
  const name = file.name || 'image';
  const budget = Math.max(0, Math.min(MAX_IMAGE_BYTES, options.budgetBytes ?? MAX_IMAGE_BYTES));
  if (file.size > budget && mimeType !== 'image/gif') {
    const limits: number[] = budget > 0 ? [budget] : [];
    if (file.size > MAX_IMAGE_BYTES && budget < MAX_IMAGE_BYTES) limits.push(MAX_IMAGE_BYTES);
    const shrink = options.shrink ?? shrinkImageToFit;
    const shrunk = limits.length > 0 ? await shrink(file, limits) : null;
    if (shrunk !== null) {
      console.info('[acp-attachment] resized an image to fit', {
        fromBytes: file.size,
        toBytes: shrunk.blob.size,
        width: shrunk.width,
        height: shrunk.height,
        mimeType: shrunk.blob.type,
      });
      return {
        ok: true,
        part: {
          kind: 'image',
          data: await base64Of(shrunk.blob),
          mimeType: shrunk.blob.type,
          name,
          sizeBytes: shrunk.blob.size,
        },
      };
    }
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: { kind: 'too-large', sizeBytes: file.size, limitBytes: MAX_IMAGE_BYTES },
    };
  }
  return {
    ok: true,
    part: { kind: 'image', data: await base64Of(file), mimeType, name, sizeBytes: file.size },
  };
}

export type AttachmentSurface = 'agent-chat' | 'composer';

export type AttachmentRejection =
  | ImageAttachmentError
  | { readonly kind: 'total-too-large'; readonly limitBytes: number }
  | { readonly kind: 'images-not-accepted' };

export interface RejectedAttachment {
  readonly size: number;
  readonly type: string;
}

export function rejectedPart(part: AttachmentPart): RejectedAttachment {
  return {
    size: embeddedAttachmentBytes(part),
    type: part.kind === 'image' || part.kind === 'blob' ? part.mimeType : '',
  };
}

export function logAttachmentRejection(
  surface: AttachmentSurface,
  rejected: RejectedAttachment,
  rejection: AttachmentRejection,
): void {
  console.warn('[acp-attachment] refused', {
    surface,
    reason: rejection.kind,
    sizeBytes: rejected.size,
    mimeType: rejected.type || '',
    ...('limitBytes' in rejection ? { limitBytes: rejection.limitBytes } : {}),
  });
}

export function collectImageFiles(dataTransfer: DataTransfer | null): File[] {
  return collectFiles(dataTransfer, (file) => file.type.startsWith('image/'));
}

export function collectAllFiles(dataTransfer: DataTransfer | null): File[] {
  return collectFiles(dataTransfer, (file) => file.size > 0);
}

function collectFiles(dataTransfer: DataTransfer | null, accept: (file: File) => boolean): File[] {
  if (dataTransfer === null) return [];
  const out: File[] = [];
  const remember = (file: File | null) => {
    if (file === null) return;
    if (!accept(file)) return;
    out.push(file);
  };
  let itemsYieldedFiles = false;
  const items = dataTransfer.items;
  if (items) {
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (it?.kind !== 'file') continue;
      const file = it.getAsFile();
      if (file === null) continue;
      itemsYieldedFiles = true;
      remember(file);
    }
  }
  if (!itemsYieldedFiles) {
    const files = dataTransfer.files;
    if (files) {
      for (let i = 0; i < files.length; i += 1) remember(files[i] ?? null);
    }
  }
  return out;
}

export interface FileToAttachmentDeps {
  readonly absPathOf?: (file: File) => string | null;
  readonly workspaceContentDir?: string;
  readonly pathSeparator?: '/' | '\\';
  readonly imageBudgetBytes?: number;
}

function workspaceRelativePath(abs: string, root: string, sep: '/' | '\\'): string | null {
  const normAbs = sep === '\\' ? abs.toLowerCase() : abs;
  const normRoot = sep === '\\' ? root.toLowerCase() : root;
  const rootWithSep = normRoot.endsWith(sep) ? normRoot : `${normRoot}${sep}`;
  if (normAbs === normRoot) return '';
  if (!normAbs.startsWith(rootWithSep)) return null;
  const rel = abs.slice(rootWithSep.length);
  return sep === '\\' ? rel.replaceAll('\\', '/') : rel;
}

function projectPathOf(
  file: File,
  deps: FileToAttachmentDeps,
): { readonly path: string } | RefusedFileLocation {
  const absPathOf = deps.absPathOf;
  const contentDir = deps.workspaceContentDir;
  if (absPathOf === undefined || contentDir === undefined || contentDir === '') return 'unknown';
  const abs = absPathOf(file);
  if (abs === null || abs === '') return 'unknown';
  const path = workspaceRelativePath(abs, contentDir, deps.pathSeparator ?? '/');
  return path === null ? 'outside-project' : { path };
}

function utf8Text(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function fileToEmbeddedAttachment(
  file: File,
  location: RefusedFileLocation,
): Promise<
  | { readonly ok: true; readonly part: AttachmentPart }
  | { readonly ok: false; readonly error: FileAttachmentError }
> {
  const name = file.name || 'attachment';
  if (file.size > MAX_EMBEDDED_FILE_BYTES) {
    return {
      ok: false,
      error: { kind: 'file-too-large', name, location, limitBytes: MAX_EMBEDDED_FILE_BYTES },
    };
  }
  const mime = file.type || '';
  const text = utf8Text(new Uint8Array(await file.arrayBuffer()));
  if (text === null) return { ok: false, error: { kind: 'not-text', name, location } };
  return {
    ok: true,
    part: {
      kind: 'blob',
      data: text,
      textPayload: true,
      mimeType: isTextishMime(mime) ? mime : 'text/plain',
      name,
      sizeBytes: file.size,
    },
  };
}

export async function fileToAttachment(
  file: File,
  deps: FileToAttachmentDeps = {},
): Promise<
  | { readonly ok: true; readonly part: AttachmentPart }
  | { readonly ok: false; readonly error: FileAttachmentError }
> {
  const mime = file.type || '';
  if (mime.startsWith('image/')) {
    return fileToImageAttachment(file, { budgetBytes: deps.imageBudgetBytes });
  }
  const found = projectPathOf(file, deps);
  if (typeof found === 'string') return fileToEmbeddedAttachment(file, found);
  return {
    ok: true,
    part: { kind: 'file', path: found.path, name: file.name || 'attachment' },
  };
}
