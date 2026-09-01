export function buildVersionNotice(version: string): string {
  return [
    version,
    'Copyright (C) 2026 Inkeep, Inc.',
    'License GPL-3.0-or-later: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.',
    'This is free software: you are free to change and redistribute it.',
    'There is NO WARRANTY, to the extent permitted by law.',
  ].join('\n');
}
