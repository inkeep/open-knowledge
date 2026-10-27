import { fileURLToPath } from 'node:url';

let cliEntryPath: string | undefined;

export function recordCliEntryPath(entryUrl: string): void {
  cliEntryPath ??= fileURLToPath(entryUrl);
}

export function recordedCliEntryPath(): string | undefined {
  return cliEntryPath;
}
