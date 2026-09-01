export const SUPPORTED_EXTENSIONS = ['.md', '.mdx'] as const;
export type DocExtension = (typeof SUPPORTED_EXTENSIONS)[number];

export function isDocExtension(value: string): value is DocExtension {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(value);
}

export function detectExtension(path: string): DocExtension | null {
  const lower = path.toLowerCase();
  for (const ext of SUPPORTED_EXTENSIONS) {
    if (lower.endsWith(ext)) return ext;
  }
  return null;
}

export function stripExt(path: string): string {
  const ext = detectExtension(path);
  return ext ? path.slice(0, -ext.length) : path;
}
