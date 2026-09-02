export const CHECK_NAMES = [
  'git',
  'bun',
  'config-yaml',
  'content-dir',
  'server-lock',
  'shadow-repo',
  'shadow-health',
  'macos-codesig',
] as const;

export type CheckName = (typeof CHECK_NAMES)[number];

export function isCheckName(value: string): value is CheckName {
  return (CHECK_NAMES as readonly string[]).includes(value);
}
