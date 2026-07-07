/**
 * Secret/PII redaction for `ok bug-report` bundles. Extracted from
 * `bug-report.ts` so it can be unit-tested directly — `bug-report.ts` imports
 * `cli.ts`, which parses argv at module load, so it can't be imported in a test.
 *
 * This is the ship-path backstop for the on-disk diagnostics logs (which now
 * include captured renderer/browser console output): `redactContent` runs over
 * every bundled file before it leaves the machine. It is best-effort pattern
 * matching, not a guarantee — see the JWT / URL-credential note below.
 */

interface SecretPattern {
  name: string;
  regex: RegExp;
  replacement: string;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: 'macos-home-path', regex: /\/Users\/[^/]+\//g, replacement: '~/' },
  { name: 'linux-home-path', regex: /\/home\/[^/]+\//g, replacement: '~/' },
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
    regex: /([Aa]uthorization:\s*[Bb]earer\s+)\S+/g,
    replacement: '$1[REDACTED]',
  },
  // JWTs (header.payload.signature; header + payload are base64url of `{`) and
  // credentials embedded in URLs (`scheme://user:pass@host`, e.g. token push
  // URLs / DB connection strings). Added because client-side console capture
  // now routes free-text renderer output into the bundled logs. No trailing
  // `\b` on the JWT — base64url's `-`/`_` aren't word chars, so a signature
  // ending in one wouldn't have a word boundary after it; the greedy class
  // consumes the whole signature instead.
  {
    name: 'jwt',
    regex: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: '[REDACTED-JWT]',
  },
  {
    name: 'url-credentials',
    regex: /:\/\/[^/\s:@]+:[^/\s:@]+@/g,
    replacement: '://[REDACTED]@',
  },
];

/** Names of the redaction patterns, for the bundle's privacy summary. */
export const SECRET_PATTERN_NAMES: readonly string[] = SECRET_PATTERNS.map((p) => p.name);

/** Apply {@link SECRET_PATTERNS} line by line; report which patterns matched. */
export function redactContent(content: string): {
  redacted: string;
  patterns: string[];
  lineCount: number;
} {
  const matchedPatterns = new Set<string>();
  let linesChanged = 0;
  const lines = content.split('\n');

  const redactedLines = lines.map((line) => {
    let modified = line;
    for (const { name, regex, replacement } of SECRET_PATTERNS) {
      regex.lastIndex = 0;
      if (regex.test(modified)) {
        matchedPatterns.add(name);
        linesChanged++;
        regex.lastIndex = 0;
        modified = modified.replace(regex, replacement);
      }
    }
    return modified;
  });

  return {
    redacted: redactedLines.join('\n'),
    patterns: [...matchedPatterns],
    lineCount: linesChanged,
  };
}
