const MISSING_HELPER_PATTERNS: readonly RegExp[] = [
  /([^\s:'"]+): (?:command )?not found/,
  /cannot run ([^:\n]+): No such file or directory/,
  /cannot exec '([^']+)': No such file or directory/,
  /git: '(credential-[^']+)' is not a git command/,
];

export function detectMissingGitHelper(stderr: string): string | null {
  for (const pattern of MISSING_HELPER_PATTERNS) {
    const match = pattern.exec(stderr);
    const command = match?.[1]?.trim();
    if (command !== undefined && command.length > 0) return command;
  }
  return null;
}
