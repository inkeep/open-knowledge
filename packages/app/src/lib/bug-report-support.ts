/**
 * Bug-report primitives shared across the reporting surfaces — the compose
 * dialog, the background send manager, its toast, and the history rows.
 *
 * These live here because each outlived the dialog that once owned them
 * privately:
 *
 *   - The support-email address. `support@inkeep.com` is the fallback transport
 *     whenever the intake endpoint is absent or the upload fails, and the
 *     follow-up address once a report has a reference.
 *   - `zipBasename`. Electron main derives a report's id as the basename of
 *     the bundle it was handed, so a renderer that keys an operation the same
 *     way keys it to the same report. Import this rather than re-deriving:
 *     two spellings of "basename" that disagree on a Windows path would key
 *     the renderer's operation to a report main has never heard of.
 *   - `formatBundleSize`. Every surface shows the bundle's on-disk size, so
 *     all of them have to round it the same way.
 *   - `bugReportNoteTitle`. The note-to-row-title derivation, kept beside the
 *     other display helpers because the renderer is its only caller.
 */

import {
  clampToCodeUnits,
  mapControlCharactersToSpace,
  stripInvisibleCharacters,
} from '@inkeep/open-knowledge-core';

const SUPPORT_EMAIL = 'support@inkeep.com';

/** Bare mailto with a prefilled subject — used where a report already has a
 *  reference, which becomes the subject so the team can correlate the email. */
export function supportMailtoUrl(subject: string): string {
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`;
}

/** Both separators, so a Windows path taken on any platform still reduces. */
export function zipBasename(zipPath: string): string {
  return zipPath.split(/[\\/]/).pop() ?? zipPath;
}

/**
 * Bundle size as the reporting surfaces render it. Deliberately not core's
 * `formatFileSize`, which reports KiB/MiB: the bug-report copy was written
 * against MB/KB labels and the two must not disagree on the same bundle.
 */
export function formatBundleSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${bytes} B`;
}

/**
 * Ceiling on the derived title, in UTF-16 code units.
 *
 * The row truncates visually with CSS, so this is not what keeps the line from
 * overflowing. It bounds the OTHER consumer: the same string goes into the
 * `title` attribute, the mechanism by which the full title is meant to stay
 * reachable, and a native tooltip has no guaranteed capacity, no scrolling and
 * no selection. Past a couple of hundred characters that promise is empty, and
 * an uncapped note would put up to 32,768 code units into a DOM attribute on
 * every row. Sits between the repo's peers: `deriveThreadTitle` caps at 48, the
 * link-preview excerpt at 240.
 */
const MAX_TITLE_LENGTH = 200;

/** Anchored on whitespace-or-end, which is what leaves `#hashtag` and a run of
 *  seven hashes alone: CommonMark reads a heading in neither. The line is
 *  trimmed before this runs, so the anchor does not need to tolerate the up-to
 *  three leading spaces CommonMark permits ahead of a marker.
 *
 *  List markers are deliberately absent, which is where this diverges from
 *  `deriveThreadTitle`'s wider lead pattern. A heading or quote marker is
 *  punctuation wrapping the whole line, so removing it leaves the sentence
 *  intact; a bullet or number introduces one step of several, and stripping it
 *  promotes a mid-thought fragment over the line the reporter actually led
 *  with. Keeping the bullet reads as a list, which is what it is. */
const BLOCK_MARKER = /^(?:#{1,6}|>)(?:[ \t]+|$)/;

/**
 * The reporter's note reduced to the one line a history row can show.
 *
 * The renderer is deliberately the only caller. Main persists the note whole
 * and never needs its first line, since the intake derives its own ticket title
 * service-side.
 *
 * The runtime type check is not redundant with the signature. `OkBugReportListRow`
 * is a type-only contract across the Electron IPC hop: the invoker casts main's
 * reply rather than validating it, so a version-skewed main, a hand-edited
 * sidecar, or a partially written file arrives as whatever it happens to be.
 * Nothing here paints a string it did not normalize.
 *
 * Invisible characters come out, then whitespace collapses, then the line
 * trims — all BEFORE the marker strip, never after. The marker alternation is anchored
 * flush-left, so anything still sitting ahead of a `#` hides it: an indent, a
 * tab the control pass turned into a space, or a zero-width character, which is
 * neither whitespace nor trimmable and would leave the row painting the `# Foo`
 * the strip exists to prevent. Normalizing first also keeps the function
 * idempotent, since a second pass would otherwise see the now-flush-left marker
 * and strip what the first pass left behind.
 *
 * The strip itself runs to a fixed point rather than once, so `## # Hello`
 * titles as `Hello`.
 *
 * The length cap applies last and does not cost idempotence: it is a function
 * of its input, and the cut is trimmed on the right, so an already-capped title
 * re-derives to itself.
 */
export function bugReportNoteTitle(note: string | undefined): string | undefined {
  if (typeof note !== 'string') return undefined;
  for (const line of note.split(/\r\n|\r|\n/)) {
    let normalized = mapControlCharactersToSpace(line);
    // Invisibles come out BEFORE the collapse, not after: removing one from
    // between two spaces would otherwise leave the double space behind, and a
    // second pass would collapse it — costing the idempotence asserted below.
    normalized = stripInvisibleCharacters(normalized).replace(/\s+/g, ' ').trim();
    while (BLOCK_MARKER.test(normalized)) {
      normalized = normalized.replace(BLOCK_MARKER, '').trim();
    }
    // trimEnd AFTER the clamp, not just before it: a cut landing on a space
    // would otherwise leave one trailing, and a second pass would remove it.
    if (normalized !== '') return clampToCodeUnits(normalized, MAX_TITLE_LENGTH).trimEnd();
  }
  return undefined;
}
