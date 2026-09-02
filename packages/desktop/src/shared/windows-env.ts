export function getWindowsEnvValue(
  env: Record<string, string | undefined>,
  wantedKey: string,
): string | undefined {
  return Object.entries(env).find(
    ([key, value]) => key.toLowerCase() === wantedKey.toLowerCase() && value !== undefined,
  )?.[1];
}

export function windowsPathKey(env: Record<string, string | undefined>): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
}

export function windowsWherePathArgs(bin: string): readonly string[] {
  return [`$PATH:${bin}`];
}
