/**
 * Regenerate `src/color-themes.generated.css` from the `COLOR_THEMES` registry
 * in `src/lib/color-themes.ts`. Run via `pnpm run gen:color-themes`. The
 * companion `src/lib/color-themes.test.ts` fails on drift, so commit the
 * regenerated file whenever a palette changes.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateColorThemesCss } from '../src/lib/color-themes';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../src/color-themes.generated.css');
writeFileSync(out, generateColorThemesCss());
console.log(`Wrote ${out}`);
