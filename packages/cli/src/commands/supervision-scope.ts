export function requiresProjectConfigForV1(command: string, args: readonly string[]): boolean {
  if (command === 'ps') return false;
  if (command !== 'stop') return true;
  const target = args.join(' ');
  return target !== 'all' && !/^\d+$/.test(target);
}
