/**
 * Helpers for resolving + safety-checking `icon` and `cover` frontmatter
 * values into renderable strings (emoji text or `<img src>` URL).
 *
 * The frontmatter shape is intentionally permissive — any string — so the
 * widget + render paths share these helpers to keep classification +
 * validation in one place.
 *
 * Classification — for a non-empty trimmed string `v`:
 *   - "emoji": `v` parses as a single grapheme cluster (or short emoji
 *     sequence) AND contains no ASCII letters. Examples: 📝, 🏔️, 🇺🇸.
 *   - "url": `v` is a safe scheme-bearing URL (http, https, etc.) AND its
 *     final path segment has an `IMAGE_EXTENSIONS` extension.
 *   - "path": `v` is a relative path (no scheme; not `javascript:` etc.)
 *     AND its final path segment has an `IMAGE_EXTENSIONS` extension.
 *   - "unsupported": anything else — `<>?javascript:`, `text-without-ext`,
 *     overly long inputs. Treated as "no icon / no cover" by the renderer.
 *
 * Cover only accepts "url" or "path" (image-shaped). Icon accepts all
 * three — the widget renders `<img>` for image kinds, `<span>` for emoji.
 *
 * Paths resolve through `toDesktopAssetHref('/api/asset?path=<value>')`
 * so the Electron renderer's `apiOrigin` rewrite applies (same pattern
 * the asset preview pane uses for inline images / videos). Authors pass
 * a contentDir-rooted path (e.g. `assets/banner.png`), not a doc-relative
 * one — keeps the storage value unambiguous across moves / renames.
 */

import { IMAGE_EXTENSIONS, isSafeUrl, toDesktopAssetHref } from '@inkeep/open-knowledge-core';

/** Hard cap on raw frontmatter value length we'll classify — anything
 * longer is rejected. Guards against pathological pastes that could
 * blow up regex / DOM rendering. 2KB is plenty for any reasonable URL or
 * emoji sequence. */
const MAX_VALUE_LENGTH = 2048;

/** Bounds for emoji grapheme classification. Real emoji sequences cap
 * out around 10-14 code points (flags + ZWJ joiner combos); 24 is a
 * very generous ceiling that still rejects pasted text. */
const MAX_EMOJI_CODE_POINTS = 24;

type PageIconKind = 'emoji' | 'url' | 'path' | 'unsupported';

export interface ResolvedPageIcon {
  kind: PageIconKind;
  /** For `emoji`: the trimmed emoji string. For `url` / `path`: the
   * desktop-rewritten `src` ready to plug into `<img>`. */
  value: string;
}

/**
 * Classify a frontmatter `icon` value. See module header for the
 * classification table; `unsupported` is the "render nothing" signal.
 */
export function resolvePageIcon(raw: unknown): ResolvedPageIcon {
  if (typeof raw !== 'string') return { kind: 'unsupported', value: '' };
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > MAX_VALUE_LENGTH) {
    return { kind: 'unsupported', value: '' };
  }

  if (isLikelyEmoji(trimmed)) {
    return { kind: 'emoji', value: trimmed };
  }

  const imageKind = classifyImageRef(trimmed);
  if (imageKind === 'url') {
    return { kind: 'url', value: trimmed };
  }
  if (imageKind === 'path') {
    return {
      kind: 'path',
      value: toDesktopAssetHref(
        `/api/asset?path=${encodeURIComponent(toContentDirRelative(trimmed))}`,
      ),
    };
  }
  return { kind: 'unsupported', value: '' };
}

export interface ResolvedPageCover {
  kind: 'url' | 'path' | 'unsupported';
  /** The desktop-rewritten `src` ready for `<img>`, or `''` for unsupported. */
  value: string;
}

/**
 * Classify a frontmatter `cover` value. Covers MUST be image-shaped — no
 * emoji fallback (banner positions need a real image).
 */
export function resolvePageCover(raw: unknown): ResolvedPageCover {
  if (typeof raw !== 'string') return { kind: 'unsupported', value: '' };
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > MAX_VALUE_LENGTH) {
    return { kind: 'unsupported', value: '' };
  }
  const imageKind = classifyImageRef(trimmed);
  if (imageKind === 'url') {
    return { kind: 'url', value: trimmed };
  }
  if (imageKind === 'path') {
    return {
      kind: 'path',
      value: toDesktopAssetHref(
        `/api/asset?path=${encodeURIComponent(toContentDirRelative(trimmed))}`,
      ),
    };
  }
  return { kind: 'unsupported', value: '' };
}

/**
 * Map a path-shaped frontmatter value onto the content-dir-relative shape
 * the asset handler expects. Stripping a single leading `/` is the
 * inverse of the upload pipeline's `url = resolved.startsWith('/') ?
 * resolved : ` + "`/${resolved}`" + `` shape (see
 * `editor/image-upload/upload-file.ts`), and matches how
 * `toDesktopAssetHref` already special-cases leading-slash hrefs in the
 * Electron renderer. Without this, `resolve(contentDir, '/x.png')`
 * server-side discards `contentDir` (Node `path.resolve` semantics for
 * an absolute second arg) and the realpath check 404s.
 */
function toContentDirRelative(value: string): string {
  return value.startsWith('/') ? value.slice(1) : value;
}

/**
 * Test whether the trimmed string is plausibly a single emoji or short
 * emoji sequence. We avoid the full Unicode emoji-property table (would
 * pull in megabytes of data tables) and use a structural heuristic:
 *   1. Code-point count is bounded (≤ 24 to allow flags + ZWJ joiners).
 *   2. No ASCII letters [a-zA-Z] — kills `http`, `assets`, etc.
 *   3. No path separator `/` — kills `assets/banner.png`.
 *   4. No `.` followed by a recognized image extension — kills
 *      `pic.png` etc. that would have classified as a path.
 *
 * This isn't a true emoji-grammar check; it's a "doesn't look like
 * text or a path" rejection that yields false-positives for niche
 * symbols (math operators, dingbats). Those still render as a glyph
 * in the icon slot, which is the acceptable v1 behavior.
 */
function isLikelyEmoji(value: string): boolean {
  // Reject ANY Unicode letter — without `\p{L}/u`, a non-Latin word
  // (Cyrillic "привет", Greek "γειά", Arabic "مرحبا") slips past the
  // ASCII-only `[a-zA-Z]` check and renders through the emoji slot.
  // Cost is a single regex; the alternative (a full Unicode emoji
  // grammar) would pull in megabytes of data tables.
  if (/\p{L}/u.test(value)) return false;
  if (value.includes('/')) return false;
  // Count code points (NOT chars — emoji can be surrogate pairs).
  let codePointCount = 0;
  for (const _ of value) codePointCount++;
  if (codePointCount > MAX_EMOJI_CODE_POINTS) return false;
  // If the value happens to look like `foo.png` (no letters but has a
  // recognized image extension), the path classifier handles it; we
  // don't want to accidentally promote `:.svg` into an emoji.
  const dotIdx = value.lastIndexOf('.');
  if (dotIdx > -1) {
    const ext = value.slice(dotIdx + 1).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) return false;
  }
  return true;
}

/**
 * Classify an image-shaped value as either a safe URL with an image
 * extension, a relative path with an image extension, or unsupported.
 *
 * Pure shape check — does NOT verify the file actually exists or fetch
 * the URL. Render-time `<img onError>` is the final fallback.
 */
function classifyImageRef(value: string): 'url' | 'path' | 'unsupported' {
  const ext = extractExtension(value);
  if (!ext || !IMAGE_EXTENSIONS.has(ext)) return 'unsupported';

  const colonIdx = value.indexOf(':');
  const slashIdx = value.indexOf('/');
  const hasScheme = colonIdx > -1 && (slashIdx === -1 || colonIdx < slashIdx);

  if (hasScheme) {
    // Has a scheme — must pass `isSafeUrl` (rejects javascript: etc).
    return isSafeUrl(value) ? 'url' : 'unsupported';
  }
  // No scheme: relative path. A single leading `/` is tolerated — the
  // upload pipeline (`/api/upload`) returns server-absolute paths
  // (`/attachments/foo.png`) that authors round-trip into frontmatter
  // verbatim, and authors sometimes type the same shape by hand. Both
  // resolve to the same content-dir-rooted location; `resolvePage*`
  // strips the leading slash before encoding into `/api/asset?path=`.
  // A DOUBLE leading slash (`//host/path`) is a network-relative URL —
  // it sneaks past `isSafeUrl` (no scheme) but `<img src>` would fetch
  // cross-origin. Reject.
  if (value.startsWith('//')) return 'unsupported';
  // Path-branch values flow into `/api/asset?path=<value>`; the server
  // runs `extname(path)` against the literal string and would see e.g.
  // `.png?v=2` (not `.png`), 415ing on missing mime. Query / hash on
  // local paths is also semantically meaningless — cache-busting and
  // anchors belong on URLs. Scope acceptance to the URL branch above.
  if (value.includes('?') || value.includes('#')) return 'unsupported';
  // Reject leading `..` to keep the load request within contentDir.
  // Path-safety on the server side (`realpath` + `isWithinContentDir`)
  // is the load-bearing check; this is a UX filter for obvious
  // mistakes.
  if (value.startsWith('../') || value.includes('/../')) return 'unsupported';
  return 'path';
}

/** Return the lowercased extension (without leading `.`), or `null`
 * if the value has no `.` or the dot is the last character. */
function extractExtension(value: string): string | null {
  // Trim any query string / hash so URLs like `image.png?v=2` classify.
  const lastSlash = value.lastIndexOf('/');
  const lastSegment = lastSlash > -1 ? value.slice(lastSlash + 1) : value;
  const queryIdx = lastSegment.search(/[?#]/);
  const filename = queryIdx > -1 ? lastSegment.slice(0, queryIdx) : lastSegment;
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === filename.length - 1) return null;
  return filename.slice(dotIdx + 1).toLowerCase();
}
