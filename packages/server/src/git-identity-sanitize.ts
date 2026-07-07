const MAX_LEN = 128;

/**
 * Sanitize a raw git identity string (user.name or user.email).
 * Strips angle brackets, CR, and LF; trims whitespace; slices to 128 chars.
 * Used at the principal load boundary and at extractAgentIdentity call sites.
 */
export function sanitizeGitIdentity(raw: string): string {
  return raw
    .replace(/[<>\r\n]/g, '')
    .trim()
    .slice(0, MAX_LEN);
}
