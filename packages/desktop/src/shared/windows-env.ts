/** Case-insensitive Windows environment lookup that preserves the original value. */
export function getWindowsEnvValue(
  env: Record<string, string | undefined>,
  wantedKey: string,
): string | undefined {
  return Object.entries(env).find(
    ([key, value]) => key.toLowerCase() === wantedKey.toLowerCase() && value !== undefined,
  )?.[1];
}

/** Preserve inherited PATH key casing when constructing a child environment. */
export function windowsPathKey(env: Record<string, string | undefined>): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
}

/** PATH-only, PATHEXT-aware `where.exe` query for a registry-authored binary name. */
export function windowsWherePathArgs(bin: string): readonly string[] {
  return [`$PATH:${bin}`];
}
