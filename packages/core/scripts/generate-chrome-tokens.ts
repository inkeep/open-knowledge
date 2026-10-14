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
console.log(`  SIDEBAR_BG_LIGHT = ${tokens.lightSidebar}`);
console.log(`  SIDEBAR_BG_DARK = ${tokens.darkSidebar}`);
console.log(`  CANVAS_BG_DARK  = ${tokens.darkCanvas}`);
