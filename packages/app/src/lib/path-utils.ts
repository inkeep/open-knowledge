/**
 * Extract the trailing path segment from a POSIX or Windows-shaped path.
 * Workspace `contentDir` is the canonical input; on macOS dev it's a
 * forward-slash path, but cross-platform compat keeps callers honest.
 */
export function extractFolderBasename(absolutePath: string): string {
  if (!absolutePath) return '';
  const normalized = absolutePath.replace(/[/\\]+$/g, '');
  const lastSlash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (lastSlash < 0) return normalized;
  return normalized.slice(lastSlash + 1);
}
