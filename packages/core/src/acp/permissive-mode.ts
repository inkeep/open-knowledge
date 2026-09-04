const PERMISSIVE = new RegExp(
  [
    'bypass',
    'acceptedits',
    'fullaccess',
    'autoedit',
    'yolo',
    'danger',
    'fullauto',
    'autoaccept',
    'autoapprove',
    'autorun',
    'skippermission',
    'noconfirm',
    'noprompt',
    'unrestricted',
    'allowall',
  ].join('|'),
);

const PERMISSIVE_EXACT = new Set(['auto']);

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '');
}

export function isPermissiveMode(mode: { id: string; name?: string }): boolean {
  const id = normalize(mode.id);
  const name = normalize(mode.name ?? '');
  if (PERMISSIVE_EXACT.has(id) || PERMISSIVE_EXACT.has(name)) return true;
  return PERMISSIVE.test(id) || PERMISSIVE.test(name);
}
