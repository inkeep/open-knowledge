import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Resolve `packageName`'s installed version by locating its `package.json`
 * via Node module resolution. Robust across layouts: workspace symlink,
 * hoisted `node_modules`, pnpm `.pnpm/`-flat, asar-packed Electron — anywhere
 * Node's resolver can find the package starting from `fromUrl`.
 *
 * Returns `undefined` when the package can't be resolved or the resolved
 * `package.json` has no `version`. Caller decides whether absence is fatal.
 *
 * `fromUrl` should be `import.meta.url` of the *calling* module so the
 * resolver walk starts from a location that actually has the target as a
 * (transitive) dep. After bundling, `import.meta.url` is the bundled-module
 * URL — that's still correct because Node's walk operates on the on-disk
 * location of the bundled file, which inherits its consumer's node_modules
 * tree.
 *
 * Strategy: ask Node to resolve the package's main entry, then walk up
 * directories until a `package.json` whose `name` matches is found. This
 * avoids relying on the package having `"./package.json"` in its `exports`
 * field (most packages don't, including this monorepo's).
 */
export async function resolvePackageVersion(
  packageName: string,
  fromUrl: string | URL,
): Promise<string | undefined> {
  let entry: string;
  try {
    entry = createRequire(fromUrl).resolve(packageName);
  } catch (err: unknown) {
    // MODULE_NOT_FOUND is the expected miss — the caller has no dep on
    // `packageName`, fail soft. Anything else (EACCES, ERR_INVALID_ARG_TYPE,
    // …) is a programming or environment fault and should surface.
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
        // malformed package.json — keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}
