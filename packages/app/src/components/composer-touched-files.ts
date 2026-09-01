const MARKDOWN_RELATIVE_PATH_EXTENSION = /\.(md|mdx)$/i;

function markdownRelativePathStem(path: string): string | null {
  return MARKDOWN_RELATIVE_PATH_EXTENSION.test(path)
    ? path.replace(MARKDOWN_RELATIVE_PATH_EXTENSION, '')
    : null;
}

export function nextTouchedFiles(
  prev: readonly string[],
  activeFilePath: string,
  dismissed: ReadonlySet<string>,
  isSeedIntact: boolean,
): readonly string[] {
  if (dismissed.has(activeFilePath)) return prev;

  if (isSeedIntact) {
    if (prev.length === 1 && prev[0] === activeFilePath) return prev;
    return [activeFilePath];
  }

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
