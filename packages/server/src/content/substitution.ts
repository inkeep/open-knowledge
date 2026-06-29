export const SUBSTITUTION_ALLOWLIST = ['date', 'user'] as const;

type SubstitutionToken = (typeof SUBSTITUTION_ALLOWLIST)[number];

interface SubstitutionContext {
  date: string;
  user: string;
}

const TOKEN_PATTERN = /\{\{([^{}\n]+?)\}\}/g;

interface UnknownTokenError {
  token: string;
  offset: number;
}

export function validateSubstitution(body: string): UnknownTokenError[] {
  const errors: UnknownTokenError[] = [];
  for (const match of body.matchAll(TOKEN_PATTERN)) {
    const token = (match[1] ?? '').trim();
    if (!isAllowedToken(token)) {
      errors.push({ token, offset: match.index ?? 0 });
    }
  }
  return errors;
}

export function applySubstitution(body: string, ctx: SubstitutionContext): string {
  return body.replace(TOKEN_PATTERN, (raw, capture: string) => {
    const token = capture.trim();
    if (!isAllowedToken(token)) return raw;
    return ctx[token];
  });
}

function isAllowedToken(token: string): token is SubstitutionToken {
  return (SUBSTITUTION_ALLOWLIST as readonly string[]).includes(token);
}

export function todayIsoUtc(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear().toString().padStart(4, '0');
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = now.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
