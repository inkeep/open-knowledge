/**
 * One-shot regenerator for `src/constants/chrome.ts`. Reads `--sidebar` from
 * `packages/app/src/globals.css`, resolves OKLCH→sRGB via culori, writes the
 * constants module verbatim. Run via:
 *
 *   bun run packages/core/scripts/generate-chrome-tokens.ts
 *
 * After running, diff the output — landing it should only flip values when
 * `--sidebar` itself moved. The drift test in
 * `packages/core/src/constants/chrome.test.ts` enforces parity at CI time.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderChromeConstantsModule, resolveChromeTokensFromCss } from './chrome-resolver.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS = resolve(HERE, '../../app/src/globals.css');
const OUTPUT = resolve(HERE, '../src/constants/chrome.ts');

const tokens = resolveChromeTokensFromCss(GLOBALS_CSS);
const moduleBody = renderChromeConstantsModule(tokens);
writeFileSync(OUTPUT, moduleBody, 'utf8');
console.log(`chrome-tokens: wrote ${OUTPUT}`);
console.log(`  CHROME_BG_LIGHT = ${tokens.light}`);
console.log(`  CHROME_BG_DARK  = ${tokens.dark}`);
