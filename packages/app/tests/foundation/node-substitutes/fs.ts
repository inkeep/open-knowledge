import { bridgeCall, readOnly } from './file-bridge';
import { fileURLToPath } from './url';

type PathLike = string | URL;
type ReadOptions = string | { readonly encoding?: string | null };

const UTF8 = new Set(['utf8', 'utf-8']);

function toPath(path: PathLike): string {
  return path instanceof URL ? fileURLToPath(path) : path;
}

export function readFileSync(path: PathLike, options?: ReadOptions): string {
  const encoding = typeof options === 'string' ? options : options?.encoding;
  if (typeof encoding !== 'string' || !UTF8.has(encoding.toLowerCase())) {
    throw new TypeError(
      'node:fs.readFileSync in the browser tier reads utf8 text only; pass "utf8"',
    );
  }
  return bridgeCall('read', toPath(path));
}

export function existsSync(path: PathLike): boolean {
  return bridgeCall('exists', toPath(path)) === 'true';
}

export function readdirSync(path: PathLike): string[] {
  return JSON.parse(bridgeCall('readdir', toPath(path))) as string[];
}

export const appendFileSync = readOnly('appendFileSync');
export const copyFileSync = readOnly('copyFileSync');
export const mkdirSync = readOnly('mkdirSync');
export const mkdtempSync = readOnly('mkdtempSync');
export const renameSync = readOnly('renameSync');
export const rmSync = readOnly('rmSync');
export const unlinkSync = readOnly('unlinkSync');
export const writeFileSync = readOnly('writeFileSync');

export default {
  readFileSync,
  existsSync,
  readdirSync,
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
};
