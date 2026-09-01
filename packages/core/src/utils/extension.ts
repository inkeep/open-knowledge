export function extensionOf(filenameOrPath: string): string {
  const basename = filenameOrPath.split('/').pop() ?? filenameOrPath;
  const idx = basename.lastIndexOf('.');
  if (idx <= 0 || idx === basename.length - 1) return '';
  return basename.slice(idx + 1).toLowerCase();
}
