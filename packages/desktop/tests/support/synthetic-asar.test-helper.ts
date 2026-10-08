import { writeFileSync } from 'node:fs';

interface AsarDir {
  files: Record<string, AsarDir | { size: number; offset: string }>;
}

export function writeSyntheticAsar(path: string, header: object): void {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(json.length + 8, 4);
  prefix.writeUInt32LE(json.length + 4, 8);
  prefix.writeUInt32LE(json.length, 12);
  writeFileSync(path, Buffer.concat([prefix, json]));
}

export function writeHeaderOnlyAsar(path: string, files: readonly string[]): void {
  const root: AsarDir = { files: {} };
  for (const file of files) {
    const segments = file.split('/');
    let dir = root;
    for (const segment of segments.slice(0, -1)) {
      const next = dir.files[segment];
      if (next && 'files' in next) {
        dir = next;
      } else {
        const created: AsarDir = { files: {} };
        dir.files[segment] = created;
        dir = created;
      }
    }
    dir.files[segments[segments.length - 1] as string] = { size: 0, offset: '0' };
  }
  writeSyntheticAsar(path, root);
}
