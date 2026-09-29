type SecretPattern =
  | { name: string; regex: RegExp; replacement: string }
  | { name: string; redact: (line: string) => string | null };

function isBase64UrlChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 45 ||
    code === 95
  );
}

const JWT_SEGMENT_MIN = 8;

const JWT_HEADER = 'eyJ';

function redactJwts(line: string): string | null {
  if (!line.includes(JWT_HEADER)) return null;
  const starts: number[] = [];
  const ends: number[] = [];
  for (let at = 0; at < line.length; at += 1) {
    if (!isBase64UrlChar(line.charCodeAt(at))) continue;
    starts.push(at);
    while (at < line.length && isBase64UrlChar(line.charCodeAt(at))) at += 1;
    ends.push(at);
  }
  const headers: number[] = [];
  for (let at = line.indexOf(JWT_HEADER); at !== -1; at = line.indexOf(JWT_HEADER, at + 1)) {
    headers.push(at);
  }
  const dotJoined = (run: number) =>
    run + 1 < starts.length &&
    line[ends[run] ?? -1] === '.' &&
    starts[run + 1] === (ends[run] ?? -1) + 1;
  const pieces: string[] = [];
  let copied = 0;
  let header = 0;
  for (let run = 0; run + 2 < starts.length; run += 1) {
    const start = starts[run] ?? 0;
    const end = ends[run] ?? 0;
    while (header < headers.length && (headers[header] ?? 0) < start) header += 1;
    if (!dotJoined(run) || !dotJoined(run + 1)) continue;
    const payloadStart = starts[run + 1] ?? 0;
    const payloadEnd = ends[run + 1] ?? 0;
    const signatureLength = (ends[run + 2] ?? 0) - (starts[run + 2] ?? 0);
    if (!line.startsWith(JWT_HEADER, payloadStart)) continue;
    if (payloadEnd - payloadStart < JWT_HEADER.length + JWT_SEGMENT_MIN) continue;
    if (signatureLength < JWT_SEGMENT_MIN) continue;
    const first = headers[header];
    if (first === undefined || first >= end || end - first < JWT_HEADER.length + JWT_SEGMENT_MIN) {
      continue;
    }
    pieces.push(line.slice(copied, first), '[REDACTED-JWT]');
    copied = ends[run + 2] ?? line.length;
    run += 2;
  }
  if (pieces.length === 0) return null;
  pieces.push(line.slice(copied));
  return pieces.join('');
}

const KEY_START = /(?:\b|(?<=(?:\[|\u009b)[0-?]*[ -/]*[@-~]))/.source;

function atKeyStart(key: RegExp): RegExp {
  return new RegExp(`${KEY_START}${key.source}`, 'g');
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    name: 'github-pat',
    regex: /(ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9]{36,}\b/g,
    replacement: '[REDACTED-GH-PAT]',
  },
  {
    name: 'aws-access-key',
    regex: atKeyStart(/(AKIA|ASIA|ABIA)[A-Z2-7]{16}\b/),
    replacement: '[REDACTED-AWS-KEY]',
  },
  {
    name: 'anthropic-key',
    regex: /sk-ant-api03-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED-ANTHROPIC]',
  },
  {
    name: 'openai-key',
    regex: atKeyStart(/sk-[A-Za-z0-9]{20,}\b/),
    replacement: '[REDACTED-OPENAI]',
  },
  {
    name: 'bearer-token',
    regex:
      /([Aa]uthorization:\s*[Bb]earer\s+)(?:\\"[^\s"\\]+\\"|"[A-Za-z0-9\-._~+/=]+"|[^\s"\\]+)/g,
    replacement: '$1[REDACTED]',
  },
  { name: 'jwt', redact: redactJwts },
  {
    name: 'url-credentials',
    regex: /:\/\/[^/\s:@"]+:[^/\s:@"]+@/g,
    replacement: '://[REDACTED]@',
  },
  {
    name: 'github-pat-fine-grained',
    regex: /github_pat_[0-9A-Za-z_]{20,}/g,
    replacement: '[REDACTED-GH-PAT]',
  },
  {
    name: 'openai-key-modern',
    regex: atKeyStart(/sk-(?:proj|svcacct|admin|None)-[A-Za-z0-9_-]{20,}/),
    replacement: '[REDACTED-OPENAI]',
  },
  { name: 'slack-token', regex: /xox[a-z]-[A-Za-z0-9-]{10,}/g, replacement: '[REDACTED-SLACK]' },
  { name: 'google-api-key', regex: /AIza[0-9A-Za-z_-]{35}/g, replacement: '[REDACTED-GOOGLE]' },
  {
    name: 'stripe-secret-key',
    regex: atKeyStart(/(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/),
    replacement: '[REDACTED-STRIPE]',
  },
  { name: 'gitlab-pat', regex: /glpat-[0-9A-Za-z_-]{20,}/g, replacement: '[REDACTED-GITLAB]' },
  {
    name: 'bearer-token-json',
    regex: /("[Aa]uthorization"\s*:\s*"[Bb]earer\s+)(?:\\"[^"\\]+\\"|[^"\\]+)/g,
    replacement: '$1[REDACTED]',
  },
  {
    name: 'macos-home-path',
    regex: /\/Users\/[^/"\r]*[^/"\r\\]/g,
    replacement: '~',
  },
  { name: 'linux-home-path', regex: /\/home\/[^/"\r]*[^/"\r\\]/g, replacement: '~' },
  {
    name: 'windows-home-path',
    regex: /[A-Za-z]:\\{1,2}Users\\{1,2}(?:(?![A-Za-z]:\\)[^\\"\r])+/gi,
    replacement: '~',
  },
];

export const SECRET_PATTERN_NAMES: readonly string[] = SECRET_PATTERNS.map((p) => p.name);

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
    for (const pattern of SECRET_PATTERNS) {
      if ('redact' in pattern) {
        const redacted = pattern.redact(modified);
        if (redacted === null) continue;
        matchedPatterns.add(pattern.name);
        changed = true;
        modified = redacted;
        continue;
      }
      const { name, regex, replacement } = pattern;
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

export function scrubSecrets(text: string): string {
  return redactSecrets(text).redacted;
}
