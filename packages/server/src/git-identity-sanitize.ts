const MAX_LEN = 128;

export function sanitizeGitIdentity(raw: string): string {
  return raw
    .replace(/[<>\r\n]/g, '')
    .trim()
    .slice(0, MAX_LEN);
}
