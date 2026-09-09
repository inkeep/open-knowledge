/** @type {Set<number>} */
export const slots = new Set<number>();

/**
 * @param {string} name
 * @returns {string}
 */
export function normalize(name: string): string {
  return name.trim();
}

/** @import { Verdict } from './allowlist.mjs' */
export const usesImport = 1;
