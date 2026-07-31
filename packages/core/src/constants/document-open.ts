export const DOCUMENT_OPEN_BYTE_LIMIT = 512 * 1024;

export function isDocumentOverOpenByteLimit(
  bytes: number | null | undefined,
  limit = DOCUMENT_OPEN_BYTE_LIMIT,
): boolean {
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes > limit;
}

/**
 * Editable text docs (code/config/plain text on the verbatim Y.Text path)
 * open in a single CodeMirror surface, which handles multi-megabyte files
 * comfortably — the markdown dual-editor's 512 KiB defer would wrongly
 * push everyday files like an 800 KB lockfile to the read-only viewer.
 * The cap only guards pathological sizes.
 */
export const TEXT_DOC_OPEN_BYTE_LIMIT = 10 * 1024 * 1024;
