const PROGRAM_LOOKUP_SWITCH = 'NoDefaultCurrentDirectoryInExePath';
const SET_BY_OPEN_KNOWLEDGE = 'open-knowledge';

type Environment = Record<string, string | undefined>;

export function isProgramLookupSwitch(name: string): boolean {
  return name.toLowerCase() === PROGRAM_LOOKUP_SWITCH.toLowerCase();
}

function switchNames(env: Environment): string[] {
  return Object.keys(env).filter((name) => isProgramLookupSwitch(name) && env[name] !== undefined);
}

export function excludeWorkingDirectoryFromProgramLookup(
  env: Environment = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32' || switchNames(env).length > 0) return;
  env[PROGRAM_LOOKUP_SWITCH] = SET_BY_OPEN_KNOWLEDGE;
}

export function withReceivedProgramLookup<Value extends string | undefined>(
  env: Readonly<Record<string, Value>>,
): Record<string, Value> {
  const received = { ...env };
  for (const name of switchNames(received)) {
    if (received[name] === SET_BY_OPEN_KNOWLEDGE) delete received[name];
  }
  return received;
}
