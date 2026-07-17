import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BiomeConfig {
  plugins?: string[];
  overrides?: Array<{ includes?: string[]; plugins?: string[] }>;
}

/**
 * Strip `//` line and block comments, then trailing commas, from JSONC text.
 * String-aware so the `//` inside a URL value (e.g. the `$schema` field)
 * survives — a plain regex strip would truncate it.
 */
function stripJsonc(text: string): string {
  let out = '';
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Read and parse the repo-root `biome.jsonc`. Node's `JSON.parse` rejects the
 * comments Biome's config carries, so parse via a string-aware JSONC strip.
 */
export function readBiomeConfig(repoRoot: string): BiomeConfig {
  const raw = readFileSync(join(repoRoot, 'biome.jsonc'), 'utf8');
  return JSON.parse(stripJsonc(raw)) as BiomeConfig;
}
