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
    regex:
      /([Aa]uthorization:\s*[Bb]earer\s+)(?:\\"[^\s"\\]+\\"|"[A-Za-z0-9\-._~+/=]+"|[^\s"\\]+)/g,
    replacement: '$1[REDACTED]',
  },
  {
    name: 'jwt',
    regex: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: '[REDACTED-JWT]',
  },
  {
    name: 'url-credentials',
    regex: /:\/\/[^/\s:@"]+:[^/\s:@"]+@/g,
    replacement: '://[REDACTED]@',
  },
  {
    name: 'github-pat-fine-grained',
    regex: /\bgithub_pat_[0-9A-Za-z_]{20,}/g,
    replacement: '[REDACTED-GH-PAT]',
  },
  {
    name: 'openai-key-modern',
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

export function scrubSecrets(text: string): string {
  return redactSecrets(text).redacted;
}
