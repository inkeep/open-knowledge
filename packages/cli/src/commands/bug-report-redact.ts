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

export const SECRET_PATTERN_NAMES: readonly string[] = SECRET_PATTERNS.map((p) => p.name);

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
