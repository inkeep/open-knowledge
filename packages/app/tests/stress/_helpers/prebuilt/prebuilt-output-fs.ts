import { readdirSync, rmSync } from 'node:fs';

const OUTPUT_DIR_NAME = /^[0-9a-f]{64}$/;

export function discardDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export function outputDigests(outRoot: string): string[] {
  return readdirSync(outRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && OUTPUT_DIR_NAME.test(entry.name))
    .map((entry) => entry.name);
}
