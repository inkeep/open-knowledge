export function isValidBundleFilePath(path: string): boolean {
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;
  if (segments.length === 0) return false;
  if (segments.length === 1 && (segments[0] as string).toLowerCase() === 'skill.md') return false;
  return !/\s/.test(path);
}
