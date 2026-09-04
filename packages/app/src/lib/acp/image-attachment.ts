import type { AttachmentPart } from '@inkeep/open-knowledge-core/acp/thread-protocol';

export const ALLOWED_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export const MAX_IMAGE_BYTES = 700 * 1024;

export type ImageAttachmentError =
  | { readonly kind: 'unsupported-type'; readonly mimeType: string }
  | { readonly kind: 'too-large'; readonly sizeBytes: number; readonly limitBytes: number }
  | { readonly kind: 'outside-workspace'; readonly name: string }
  | { readonly kind: 'unknown-path'; readonly name: string };

export type FileAttachmentError = ImageAttachmentError;

export function describeImageError(error: ImageAttachmentError): string {
  if (error.kind === 'unsupported-type') {
    if (error.mimeType.startsWith('image/')) {
      return `Only PNG, JPEG, GIF, and WebP images are supported (got ${error.mimeType}).`;
    }
    return `Unsupported file type: ${error.mimeType || 'unknown'}.`;
  }
  if (error.kind === 'outside-workspace') {
    return `${error.name} is outside the workspace. Move it into your project first.`;
  }
  if (error.kind === 'unknown-path') {
    return `${error.name} has no resolvable path — the agent can only read files inside the workspace.`;
  }
  const mb = (error.limitBytes / (1024 * 1024)).toFixed(1);
  return `File is too large (${(error.sizeBytes / (1024 * 1024)).toFixed(1)} MB) — max ${mb} MB per attachment.`;
}

async function encodeImageFile(file: File): Promise<{
  readonly data: string;
  readonly mimeType: string;
  readonly name: string;
  readonly sizeBytes: number;
}> {
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
    reader.readAsDataURL(file);
  });
  const comma = dataUrl.indexOf(',');
  const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return {
    data,
    mimeType: file.type || 'application/octet-stream',
    name: file.name || 'image',
    sizeBytes: file.size,
  };
}

export async function fileToImageAttachment(
  file: File,
): Promise<
  | { readonly ok: true; readonly part: AttachmentPart }
  | { readonly ok: false; readonly error: ImageAttachmentError }
> {
  const mimeType = file.type || '';
  if (!ALLOWED_IMAGE_MIMES.has(mimeType)) {
    return { ok: false, error: { kind: 'unsupported-type', mimeType } };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: { kind: 'too-large', sizeBytes: file.size, limitBytes: MAX_IMAGE_BYTES },
    };
  }
  const encoded = await encodeImageFile(file);
  return {
    ok: true,
    part: {
      kind: 'image',
      data: encoded.data,
      mimeType: encoded.mimeType,
      name: encoded.name,
      sizeBytes: encoded.sizeBytes,
    },
  };
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
      if (!it || it.kind !== 'file') continue;
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

export async function fileToAttachment(
  file: File,
  deps: FileToAttachmentDeps = {},
): Promise<
  | { readonly ok: true; readonly part: AttachmentPart }
  | { readonly ok: false; readonly error: FileAttachmentError }
> {
  const mime = file.type || '';
  if (mime.startsWith('image/')) return fileToImageAttachment(file);
  const absPathOf = deps.absPathOf;
  const contentDir = deps.workspaceContentDir;
  const sep = deps.pathSeparator ?? '/';
  const name = file.name || 'attachment';
  if (absPathOf === undefined || contentDir === undefined || contentDir === '') {
    return { ok: false, error: { kind: 'unknown-path', name } };
  }
  const abs = absPathOf(file);
  if (abs === null || abs === '') {
    return { ok: false, error: { kind: 'unknown-path', name } };
  }
  const rel = workspaceRelativePath(abs, contentDir, sep);
  if (rel === null) {
    return { ok: false, error: { kind: 'outside-workspace', name } };
  }
  return {
    ok: true,
    part: { kind: 'file', path: rel, name },
  };
}
