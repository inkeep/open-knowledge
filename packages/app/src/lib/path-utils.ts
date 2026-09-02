export function extractFolderBasename(absolutePath: string): string {
  if (!absolutePath) return '';
  const normalized = absolutePath.replace(/[/\\]+$/g, '');
  const lastSlash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (lastSlash < 0) return normalized;
  return normalized.slice(lastSlash + 1);
}
