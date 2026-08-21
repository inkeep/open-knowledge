/**
 * Turn a dropped, pasted, or picked `File` into an `AttachmentPart` ready
 * for the ACP composer's outbound send. Two paths: image files (PNG/JPEG/
 * GIF/WebP under the per-image cap) become `image` parts; non-image files
 * become `file` parts pointing at a workspace-relative path — the server
 * resolves those to `EmbeddedResource` (text under the embed cap) or
 * `ResourceLink` (binaries + oversized). Rejects files outside the
 * workspace up front so a path the agent can't reach never leaves the
 * client, and rejects over-cap images so a busted attachment doesn't
 * ride the wire and get dropped server-side.
 */

import type { AttachmentPart } from '@inkeep/open-knowledge-core/acp/thread-protocol';

/** Images the ACP `ImageContent` block explicitly accepts across the agents
 *  we ship (Claude, Codex, Cursor). PNG/JPEG/GIF/WebP is the intersection;
 *  SVG is deliberately excluded — agents interpret raster payloads reliably
 *  and vector formats' scripting surface makes them a poor default. */
export const ALLOWED_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Per-image raw-byte ceiling — sized so the base64-encoded prompt frame
 *  stays under the collab WebSocket's 1 MiB `maxPayload` cap (see
 *  `collaboration-host.ts` `MAX_COLLAB_MESSAGE_BYTES`). Base64 inflates
 *  bytes ~4/3×, and the frame carries other fields (text, chip mentions,
 *  wrapping JSON), so 700 KiB raw ≈ 933 KiB encoded — enough headroom for
 *  the surrounding prompt without tripping `ws` code 1009. Enforced per
 *  attachment; going higher makes the WS silently drop the message. */
export const MAX_IMAGE_BYTES = 700 * 1024;

export type ImageAttachmentError =
  | { readonly kind: 'unsupported-type'; readonly mimeType: string }
  | { readonly kind: 'too-large'; readonly sizeBytes: number; readonly limitBytes: number }
  | { readonly kind: 'outside-workspace'; readonly name: string }
  | { readonly kind: 'unknown-path'; readonly name: string };

/** Errors from the more permissive `fileToAttachment` path — includes the
 *  image ones plus a generic too-large for non-image blobs. */
export type FileAttachmentError = ImageAttachmentError;

/** Format an error for a user-visible toast. Kept out of the React tree so
 *  every host uses the same wording (and translation).  */
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

/** Read a File as base64, stripping the `data:<mime>;base64,` prefix the
 *  browser hands us in `FileReader.result`. Rejects on a broken read. */
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

/**
 * End-to-end conversion: validate, encode, wrap as `AttachmentPart`. Returns
 * either the part or a classified error the caller renders as a toast. Never
 * throws for a client-input problem — those go through `Err`.
 */
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

/**
 * Yield image files from a DataTransfer — the drop-event and paste-event
 * source. `items` is the authoritative list; `files` is consulted only when
 * `items` yields nothing, so a screenshot pasted from the OS clipboard is
 * handled the same as a file dragged from Finder without either being read
 * twice.
 */
export function collectImageFiles(dataTransfer: DataTransfer | null): File[] {
  return collectFiles(dataTransfer, (file) => file.type.startsWith('image/'));
}

/**
 * Yield ALL files (any mime) from a DataTransfer — the wider path the
 * agent-thread panel uses so a code file dragged from Finder attaches the
 * same way a PNG does. Same items-first, files-as-fallback traversal as the
 * image-only variant. Excludes zero-byte entries (dragging a folder from
 * Finder emits an entry with size 0 that browsers can't read as bytes).
 */
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
  // `items` is the authoritative list: per the HTML drag-and-drop spec,
  // `DataTransfer.files` IS the `kind: 'file'` subset of `DataTransfer.items`,
  // so the two accessors describe one payload set rather than two. Reading
  // both and de-duplicating by value is therefore the wrong shape — and it
  // could not be made correct, because a clipboard payload has no file on
  // disk: the host builds a fresh `File` per read and stamps `lastModified`
  // with the clock at construction, so the two reads of one pasted image
  // disagree on it whenever they straddle a millisecond, and any key carrying
  // that field misses, so one paste lands as two attachments.
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
  // Fall back to `files` only when `items` produced nothing — an older host
  // that leaves `items` unpopulated, or a synthetic DataTransfer. Guarding on
  // "yielded a File" rather than "had file-kind entries" keeps the fallback
  // live when `getAsFile()` returns null for every entry.
  if (!itemsYieldedFiles) {
    const files = dataTransfer.files;
    if (files) {
      for (let i = 0; i < files.length; i += 1) remember(files[i] ?? null);
    }
  }
  return out;
}

/** Options `fileToAttachment` needs to enforce the workspace-containment
 *  rule for non-image files. `absPathOf` recovers the on-disk path from a
 *  File (Electron `webUtils.getPathForFile`); web hosts pass `undefined`
 *  and only images ride through. `workspaceContentDir` is the absolute
 *  workspace root; a path outside it is refused. */
export interface FileToAttachmentDeps {
  readonly absPathOf?: (file: File) => string | null;
  readonly workspaceContentDir?: string;
  readonly pathSeparator?: '/' | '\\';
}

/** Resolve `abs` to a workspace-relative path if it lives inside `root`,
 *  else null. Comparison is case-sensitive on POSIX, case-insensitive on
 *  Windows (matching `confineToContentDir`'s stance). No `..` traversal
 *  because we only trust paths the OS handed us via `webUtils.getPathForFile`. */
function workspaceRelativePath(abs: string, root: string, sep: '/' | '\\'): string | null {
  const normAbs = sep === '\\' ? abs.toLowerCase() : abs;
  const normRoot = sep === '\\' ? root.toLowerCase() : root;
  const rootWithSep = normRoot.endsWith(sep) ? normRoot : `${normRoot}${sep}`;
  if (normAbs === normRoot) return '';
  if (!normAbs.startsWith(rootWithSep)) return null;
  const rel = abs.slice(rootWithSep.length);
  // Always serialize workspace paths POSIX-style — the server + wire
  // contract expect forward slashes.
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
  // Non-image path: require an on-disk file that lives inside the workspace.
  // Zed's behavior — files outside the project root aren't sent; the agent's
  // tools can't reach them anyway, so refusing up-front is honest and cheap.
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
