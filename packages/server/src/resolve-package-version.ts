import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export async function resolvePackageVersion(
  packageName: string,
  fromUrl: string | URL,
): Promise<string | undefined> {
  let entry: string;
  try {
    entry = createRequire(fromUrl).resolve(packageName);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'MODULE_NOT_FOUND') return undefined;
    throw err;
  }

  for (let dir = dirname(entry), i = 0; i < 32; i += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(await readFile(candidate, 'utf-8')) as {
          name?: string;
          version?: string;
        };
        if (parsed.name === packageName && typeof parsed.version === 'string') {
          return parsed.version;
        }
      } catch {
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}
