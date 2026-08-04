/**
 * Portable filename sanitization for attacker-influenced names (multipart
 * upload filenames, imported SKILL.md frontmatter names). Pure string work,
 * shared across capability services so none depends on a sibling for it.
 */

// unicode-preserving. Permits any Unicode letter, number, or combining
// mark, plus pictographic emoji and the punctuation whitelist (., -, _, space).
// Everything else (including `/`, `\`, null bytes, control chars, CRLF) is
// either stripped or replaced so path-escape guards downstream keep their
// invariants. CJK, Arabic, Cyrillic, and emoji survive — macOS/Finder
// ergonomics without sacrificing filesystem safety.
const SAFE_FILENAME_CHARS = /[^\p{L}\p{N}\p{M}\p{Extended_Pictographic}.\-_ ]/gu;
// Stripping C0 + DEL is the whole point — the rule fires on intentional use.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — sanitize must strip control bytes.
const STRIP_ON_SIGHT = /[/\\\x00-\x1f\x7f]/g;

export function sanitizeFilename(name: string): string {
  // Strip path separators and null/control bytes BEFORE any other pass so
  // they cannot reappear inside a replacement and dodge later checks.
  let stripped = name.replace(STRIP_ON_SIGHT, '');
  stripped = stripped.replace(SAFE_FILENAME_CHARS, '_');

  // Collapse underscore and dot runs so "../etc/passwd" → "etcpasswd" and
  // "foo__bar" → "foo_bar".
  stripped = stripped.replace(/_+/g, '_').replace(/\.{2,}/g, '.');

  // No hidden files — trim leading dots and leading underscores.
  stripped = stripped.replace(/^[._]+/, '');
  // Filesystem portability — strip trailing dots (Windows trims them too).
  stripped = stripped.replace(/\.+$/, '');

  if (stripped === '') return 'upload';

  // Most filesystems cap basenames at 255 bytes (ext4, APFS, exFAT). Without a
  // ceiling, a multipart `Content-Disposition` filename approaching busboy's
  // header size can sail through Unicode-letter sanitization and surface as
  // `ENAMETOOLONG` from `linkSync`, which classifies as a generic
  // `storage-error` → 500. Truncate the stem (preserving the extension) to
  // stay within the portable basename ceiling.
  const MAX_BYTES = 255;
  const encoder = new TextEncoder();
  if (encoder.encode(stripped).length > MAX_BYTES) {
    const dotIdx = stripped.lastIndexOf('.');
    const ext = dotIdx >= 0 ? stripped.slice(dotIdx) : '';
    let stem = dotIdx >= 0 ? stripped.slice(0, dotIdx) : stripped;
    // `slice(0, -1)` removes one UTF-16 code unit. A trailing emoji is a
    // surrogate pair, so the loop transiently produces a lone-surrogate
    // string that `TextEncoder` re-encodes as U+FFFD (3 bytes) — harmless
    // since the emoji is fully consumed before the loop exits and the
    // returned string is always valid UTF-8.
    while (encoder.encode(stem + ext).length > MAX_BYTES && stem.length > 0) {
      stem = stem.slice(0, -1);
    }
    stripped = (stem || 'upload') + ext;
    // The loop drains the stem; it cannot shrink the extension itself.
    // An adversarial 250+ byte extension (e.g. `'x.' + 'a'.repeat(300)`)
    // would drain the stem to empty and still leave `'upload' + ext`
    // above the ceiling. Final-pass guard: fall back to extensionless
    // `'upload'` when even the floor exceeds MAX_BYTES.
    if (encoder.encode(stripped).length > MAX_BYTES) stripped = 'upload';
  }

  return stripped;
}
