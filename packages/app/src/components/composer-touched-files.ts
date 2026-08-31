/**
 * Which files the Ask AI composer carries as top-row context chips.
 *
 * Extracted from `BottomComposer` because the rule has been wrong in both
 * directions: seeding the conflict instruction made every visited doc attach
 * itself (the draft read as "the user is composing"), and suppressing that
 * dropped even the file the instruction names. In the composer it is reachable
 * only through the whole component's mock surface; here it is a function.
 */

const MARKDOWN_RELATIVE_PATH_EXTENSION = /\.(md|mdx)$/i;

/** The path minus its markdown extension, or null when it has none. */
function markdownRelativePathStem(path: string): string | null {
  return MARKDOWN_RELATIVE_PATH_EXTENSION.test(path)
    ? path.replace(MARKDOWN_RELATIVE_PATH_EXTENSION, '')
    : null;
}

export function nextTouchedFiles(
  prev: readonly string[],
  activeFilePath: string,
  dismissed: ReadonlySet<string>,
  /** The draft is this composer's own untouched seed — nobody has typed. */
  isSeedIntact: boolean,
): readonly string[] {
  // Sticky-dismissed paths are never re-added, seeded or not.
  if (dismissed.has(activeFilePath)) return prev;

  if (isSeedIntact) {
    // The seed names exactly one file and the user composed nothing, so the set
    // REPLACES. Accumulating would attach every conflicted doc they clicked
    // through; returning `prev` unchanged would drop the one it is about.
    if (prev.length === 1 && prev[0] === activeFilePath) return prev;
    return [activeFilePath];
  }

  // Composing: accumulate on switch, minus any stale extension-variant of the
  // same stem (a doc that changed .md <-> .mdx keeps one entry, not two).
  const activeStem = markdownRelativePathStem(activeFilePath);
  const next =
    activeStem === null
      ? prev
      : prev.filter(
          (path) => path === activeFilePath || markdownRelativePathStem(path) !== activeStem,
        );
  if (next.includes(activeFilePath)) return next.length === prev.length ? prev : next;
  return [...next, activeFilePath];
}
