/**
 * Desktop clip intake helpers for Web Clipper payload processing.
 *
 * Implements filename sanitization, traversal prevention, and deterministic
 * collision resolution ("Keep both") for clipped documents.
 */

import { basename, extname } from 'node:path';

/**
 * Sanitize a suggested filename or title for a clipped document.
 * Strips directory traversal, invalid characters, null bytes, and forces
 * a `.md` extension.
 */
export function sanitizeClipFilename(suggestedFilename?: string, title?: string): string {
  const candidate = (suggestedFilename ?? title ?? 'clipped-document').trim();
  // Strip path segments using basename first, then replace forbidden filename characters
  let clean = basename(candidate)
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '-')
    .replace(/^(?:\.\.+[/\\|]?)+/, '')
    .trim();

  if (clean.length === 0 || clean === '.' || clean === '..') {
    clean = 'clipped-document';
  }

  const ext = extname(clean).toLowerCase();
  if (ext !== '.md' && ext !== '.mdx') {
    clean = `${clean}.md`;
  }

  return clean;
}

/**
 * Resolve a non-colliding filename when a document with the target name already exists.
 * Implements the "Keep both" collision policy (e.g., `article.md` -> `article-1.md`).
 */
export function resolveNonCollidingFilename(
  existingDocNames: ReadonlySet<string>,
  targetFilename: string,
): string {
  if (!existingDocNames.has(targetFilename)) {
    return targetFilename;
  }

  const ext = extname(targetFilename);
  const stem = targetFilename.slice(0, targetFilename.length - ext.length);

  let counter = 1;
  let candidate = `${stem}-${counter}${ext}`;
  while (existingDocNames.has(candidate)) {
    counter += 1;
    candidate = `${stem}-${counter}${ext}`;
  }

  return candidate;
}
