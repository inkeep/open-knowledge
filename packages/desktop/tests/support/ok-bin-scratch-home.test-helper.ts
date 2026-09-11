import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MINIMAL_PARENT_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');

export const RC_WITHOUT_MANAGED_BLOCK = '# user rc, with the OpenKnowledge PATH block declined\n';

export const RC_FILES = ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile'];

export interface ScratchOkHomeOptions {
  readonly prefix: string;
  readonly bins: readonly string[];
  readonly exitCode?: number;
  readonly recordPath?: string;
}

function sentinelScript(exitCode: number, recordPath: string | undefined): string {
  const record =
    recordPath === undefined
      ? ''
      : `printf '%s' "$PATH" > '${recordPath.replace(/'/g, `'\\''`)}'\nprintf '%s' "$HOME" > '${recordPath.replace(/'/g, `'\\''`)}.home'\n`;
  return `#!/bin/sh\n${record}exit ${exitCode}\n`;
}

export function createScratchHomeWithOkBin(options: ScratchOkHomeOptions): string {
  const home = mkdtempSync(join(tmpdir(), options.prefix));
  const okBin = join(home, '.ok', 'bin');
  mkdirSync(okBin, { recursive: true });
  const script = sentinelScript(options.exitCode ?? 0, options.recordPath);
  for (const bin of options.bins) {
    const path = join(okBin, bin);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }
  for (const rc of RC_FILES) writeFileSync(join(home, rc), RC_WITHOUT_MANAGED_BLOCK);
  return home;
}

export function createRecordDir(): string {
  return mkdtempSync(join(tmpdir(), 'ok-bin-child-record-'));
}

export function firstShellOnDisk(): string {
  const found = ['/bin/zsh', '/bin/bash', '/bin/sh'].find((candidate) => existsSync(candidate));
  if (found === undefined) throw new Error('no POSIX shell on disk to exercise the probe against');
  return found;
}
