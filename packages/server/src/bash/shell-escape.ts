export function shellEscape(arg: string): string {
  if (arg === '') return "''";
  if (/^[\w.\-/]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
