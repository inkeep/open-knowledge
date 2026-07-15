/**
 * Regenerate `src/color-themes.generated.css` from the `COLOR_THEMES` registry
 * in `src/lib/color-themes.ts`. Run via `bun run gen:color-themes`. The
 * companion `src/lib/color-themes.generated.test.ts` fails on drift, so commit
 * the regenerated file whenever a palette changes.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateColorThemesCss } from '../src/lib/color-themes';

const out = resolve(import.meta.dir, '../src/color-themes.generated.css');
writeFileSync(out, generateColorThemesCss());
console.log(`Wrote ${out}`);
