
export function relativeToProject(projectDir: string, picked: string): string | null {
  const normalize = (p: string): string =>
    p.replace(/\\/g, '/').replace(/\/+$/, '') || (p.startsWith('/') ? '/' : '');
  const root = normalize(projectDir);
  const target = normalize(picked);
  if (root === target) return '.';
  const prefix = root.endsWith('/') ? root : `${root}/`;
  if (!target.startsWith(prefix)) return null;
  return target.slice(prefix.length);
}

export function isContentDirSafe(value: string): boolean {
  if (value === '' || value === '.') return true;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.replace(/\\/g, '/').split('/');
  let depth = 0;
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      depth -= 1;
      if (depth < 0) return false;
    } else {
      depth += 1;
    }
  }
  return true;
}
