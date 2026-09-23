import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const ENTITY_DECODER_ID = 'decode-named-character-reference';

/* STOP: `decode-named-character-reference` reads entities through `document.createElement` in the
   build every bundler picks under the `browser` condition, so importing anything that parses
   Markdown inside a worker throws at module load. Its default build decodes from a table --
   what Node and the package's own `worker` condition use -- and Vite 8 has no worker-scoped
   resolve options, so the alias is global. Same decoder, same results, no DOM. Returning null
   leaves the browser build in place rather than breaking resolution. */
export function resolveEntityDecoderNodeBuild(appDir: string): string | null {
  const repoRoot = join(appDir, '..', '..');
  try {
    const resolved = createRequire(join(repoRoot, 'package.json')).resolve(ENTITY_DECODER_ID);
    const nodeBuild = resolved.replace(/index\.dom\.js$/, 'index.js');
    if (existsSync(nodeBuild)) return nodeBuild;
  } catch {}
  const store = join(repoRoot, 'node_modules', '.pnpm');
  if (!existsSync(store)) return null;
  const versioned = readdirSync(store).find((name) => name.startsWith(`${ENTITY_DECODER_ID}@`));
  if (versioned === undefined) return null;
  const nodeBuild = join(store, versioned, 'node_modules', ENTITY_DECODER_ID, 'index.js');
  return existsSync(nodeBuild) ? nodeBuild : null;
}
