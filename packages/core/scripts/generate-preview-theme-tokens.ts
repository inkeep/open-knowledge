/**
 * One-shot regenerator for `src/constants/preview-theme-tokens.ts`. Reads the
 * preview token subset from `packages/app/src/globals.css`, resolves `var()`
 * indirections, and writes the constants module verbatim. Run via:
 *
 *   bun run packages/core/scripts/generate-preview-theme-tokens.ts
 *
 * After running, diff the output — landing it should only flip values when a
 * listed token in `globals.css` actually moved. The drift test in
 * `packages/core/src/constants/preview-theme-tokens.test.ts` enforces parity
 * at CI time (no separate `--check` mode needed — the unit test is the gate).
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderPreviewThemeTokensModule,
  resolvePreviewThemeTokensFromCss,
} from './preview-theme-token-resolver.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const GLOBALS_CSS = resolve(HERE, '../../app/src/globals.css');
const OUTPUT = resolve(HERE, '../src/constants/preview-theme-tokens.ts');

const tokens = resolvePreviewThemeTokensFromCss(GLOBALS_CSS);
const moduleBody = renderPreviewThemeTokensModule(tokens);
writeFileSync(OUTPUT, moduleBody, 'utf8');
console.log(`preview-theme-tokens: wrote ${OUTPUT} (${tokens.length} tokens)`);
for (const t of tokens) {
  console.log(`  ${t.name.padEnd(22)} light=${t.light.padEnd(26)} dark=${t.dark}`);
}
