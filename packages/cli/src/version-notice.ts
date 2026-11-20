export function buildVersionNotice(version: string): string {
  return [
    version,
    'Copyright (C) 2026 Inkeep, Inc.',
    'License GPL-3.0-or-later: GNU GPL version 3 or later <https://gnu.org/licenses/gpl.html>.',
    'This is free software: you are free to change and redistribute it.',
    'There is NO WARRANTY, to the extent permitted by law.',
    'Includes node-liblzma, Copyright (C) 2014-2015 Olivier Orabona, under LGPL-3.0; its license text is in THIRD_PARTY_NOTICES.md in this package.',
  ].join('\n');
}
