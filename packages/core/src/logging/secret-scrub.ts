/**
 * Canonical secret / credential scrub. One pattern list shared by every surface
 * that captures text or ships it off the machine, so they can never drift:
 *
 *   - the diagnostic-bundle assembly (`redactSecrets` over each staged file),
 *   - the web renderer console-capture forwarder, and
 *   - the Electron main `console-message` capture, whose sink is the local
 *     `~/.ok/logs/desktop.<date>.log`.
 *
 * Both capture sites take the scrub through `prepareCapturedConsoleMessage`
 * (`renderer-log.ts`) or call `scrubSecrets` directly; the local log file has
 * no keyed-field redaction in front of it, so capture time is the only place
 * the scrub can happen.
 *
 * Best-effort pattern matching, not a guarantee — see the JWT / URL-credential
 * note below. Credentials are scrubbed unconditionally; document titles and
 * content are governed separately (never by this module).
 *
 * Browser-safe: pure string operations, no Node dependencies.
 */

interface SecretPattern {
  name: string;
  regex: RegExp;
  replacement: string;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    name: 'github-pat',
    regex: /\b(ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{36,}\b/g,
    replacement: '[REDACTED-GH-PAT]',
  },
  {
    name: 'aws-access-key',
    regex: /\b(AKIA|ASIA|ABIA)[A-Z2-7]{16}\b/g,
    replacement: '[REDACTED-AWS-KEY]',
  },
  {
    name: 'anthropic-key',
    regex: /\bsk-ant-api03-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED-ANTHROPIC]',
  },
  { name: 'openai-key', regex: /\bsk-[A-Za-z0-9]{20,}\b/g, replacement: '[REDACTED-OPENAI]' },
  {
    name: 'bearer-token',
    // Three alternatives, ordered, so the token's own quoting is matched as part
    // of the token: escaped-quoted, quoted, bare. What a bare token may not
    // contain is the bound — NOT a spelling of what it may be. RFC 6750's
    // `b64token` looked like the safer statement and is not: the first character
    // outside it ends the match, so `Bearer abc:123` redacted `abc` and shipped
    // `:123`, with the audit still naming the pattern as having fired. A
    // surviving fragment recorded as redacted is worse than a clean miss —
    // where the character ending the match is one a real credential can hold.
    //
    // Two constraints on the shape. The bare branch must not contain a
    // backslash ANYWHERE — not merely start on one. Taking the `\` of a `\"`
    // escape leaves the value's closing quote exposed, which breaks the line
    // whether the backslash was the first character or the fourth.
    //
    // That bound has the same shape as the cost above and is accepted on the
    // narrower ground: a value carrying a backslash truncates there, tail
    // shipped and pattern still named. `b64token` excludes the backslash, so no
    // conformant bearer credential contains one — unlike `:` or `%`, which real
    // composite and URL-encoded tokens do. And in serialized JSON the backslash
    // is usually the start of an escape, where stopping IS the right boundary:
    // `Bearer TOK\nnext line` truncates at the newline that ends the token.
    // And the QUOTED branch keeps the narrow class deliberately: its opening `"`
    // can bind a value's closing delimiter, and with a permissive body it would
    // then run through the comma into the next key.
    regex:
      /([Aa]uthorization:\s*[Bb]earer\s+)(?:\\"[^\s"\\]+\\"|"[A-Za-z0-9\-._~+/=]+"|[^\s"\\]+)/g,
    replacement: '$1[REDACTED]',
  },
  // JWTs (header.payload.signature; header + payload are base64url of `{`) and
  // credentials embedded in URLs (`scheme://user:pass@host`, e.g. token push
  // URLs / DB connection strings). No trailing `\b` on the JWT — base64url's
  // `-`/`_` aren't word chars, so a signature ending in one wouldn't have a
  // word boundary after it; the greedy class consumes the whole signature.
  {
    name: 'jwt',
    regex: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: '[REDACTED-JWT]',
  },
  {
    name: 'url-credentials',
    // The classes also exclude `"`, so the match cannot run across a JSON
    // delimiter and swallow the key after it. ONLY the quote is added: RFC 3986
    // permits sub-delims such as `,` in userinfo, and excluding those would
    // narrow what this recognises on a security path.
    regex: /:\/\/[^/\s:@"]+:[^/\s:@"]+@/g,
    replacement: '://[REDACTED]@',
  },
  // Current-default provider formats the classic prefixes above miss: GitHub
  // fine-grained PATs (`github_pat_`, not `ghp_`), the OpenAI project/service
  // keys issued since 2024 (`sk-proj-`/`sk-svcacct-`, whose `-` breaks the
  // legacy `sk-[A-Za-z0-9]+`), plus Slack, Google, Stripe, and GitLab. Each is
  // single-quantifier (no ReDoS); over-redaction is the safe direction.
  {
    name: 'github-pat-fine-grained',
    regex: /\bgithub_pat_[0-9A-Za-z_]{20,}/g,
    replacement: '[REDACTED-GH-PAT]',
  },
  {
    name: 'openai-key-modern',
    // No trailing \b: the body may end in `-`/`_` (same rationale as the jwt pattern).
    regex: /\bsk-(?:proj|svcacct|admin|None)-[A-Za-z0-9_-]{20,}/g,
    replacement: '[REDACTED-OPENAI]',
  },
  { name: 'slack-token', regex: /\bxox[a-z]-[A-Za-z0-9-]{10,}/g, replacement: '[REDACTED-SLACK]' },
  { name: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}/g, replacement: '[REDACTED-GOOGLE]' },
  {
    name: 'stripe-secret-key',
    regex: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/g,
    replacement: '[REDACTED-STRIPE]',
  },
  { name: 'gitlab-pat', regex: /\bglpat-[0-9A-Za-z_-]{20,}/g, replacement: '[REDACTED-GITLAB]' },
  {
    name: 'bearer-token-json',
    // JSON-serialized wire form: `"authorization":"Bearer <opaque>"`, which the
    // colon-anchored `bearer-token` pattern above cannot see. Same quote-and-
    // backslash bound as that one, and for the same reason — an unescaped quote
    // inside a JSON string value can only be that value's own terminator, but a
    // backslash can still be the escape that precedes one, and a body admitting
    // it closes the string early.
    //
    // TWO deliberate divergences from the sibling, neither of which TypeScript
    // can catch when one side is edited alone. This body does NOT exclude `\s`:
    // it already sits inside a quoted value, where whitespace is token material
    // rather than the terminator it is in free text. And there are two branches
    // rather than three — no plain-quoted branch, because an opening quote can
    // never appear mid-value, so that branch could not fire.
    regex: /("[Aa]uthorization"\s*:\s*"[Bb]earer\s+)(?:\\"[^"\\]+\\"|[^"\\]+)/g,
    replacement: '$1[REDACTED]',
  },
  // Cosmetic, and LAST on purpose. These collapse a home directory to `~/`,
  // which is lossy in a way a credential pattern is not: the match consumes the
  // segment it replaces. Run ahead of the credential patterns, they could eat
  // text one of those still needs to recognise its own match — a `/Users/<name>/`
  // run reaching across a `://` leaves no `://` for the URL-credential pattern to
  // anchor on, and the credential then ships verbatim.
  //
  // The bodies exclude the quote and NOTHING else. A space or a backslash is a
  // legal part of an account name — `/Users/Jane Doe/` is the macOS shape this
  // repo's own fixtures use — and excluding either silently stopped those from
  // being masked at all, which on the file's only two privacy patterns is the
  // wrong direction to be wrong in.
  //
  // A home path at the very end of a JSON string value is left alone, having no
  // trailing slash inside its own value to match: reaching it would mean running
  // through the closing quote, which is what deleted the following field.
  { name: 'macos-home-path', regex: /\/Users\/[^/"]+\//g, replacement: '~/' },
  { name: 'linux-home-path', regex: /\/home\/[^/"]+\//g, replacement: '~/' },
];

/** Names of the redaction patterns, for a bundle's privacy summary. */
export const SECRET_PATTERN_NAMES: readonly string[] = SECRET_PATTERNS.map((p) => p.name);

/** Apply {@link SECRET_PATTERNS} line by line; report which patterns matched. */
export function redactSecrets(content: string): {
  redacted: string;
  patterns: string[];
  lineCount: number;
} {
  const matchedPatterns = new Set<string>();
  let linesChanged = 0;
  const lines = content.split('\n');

  const redactedLines = lines.map((line) => {
    let modified = line;
    let changed = false;
    for (const { name, regex, replacement } of SECRET_PATTERNS) {
      regex.lastIndex = 0;
      if (regex.test(modified)) {
        matchedPatterns.add(name);
        changed = true;
        regex.lastIndex = 0;
        modified = modified.replace(regex, replacement);
      }
    }
    if (changed) linesChanged++;
    return modified;
  });

  return {
    redacted: redactedLines.join('\n'),
    patterns: [...matchedPatterns],
    lineCount: linesChanged,
  };
}

/**
 * Scrub credentials from a free-text string, returning only the cleaned text.
 * The capture-time form for renderer console output, where the per-file audit
 * that {@link redactSecrets} produces isn't needed.
 */
export function scrubSecrets(text: string): string {
  return redactSecrets(text).redacted;
}
