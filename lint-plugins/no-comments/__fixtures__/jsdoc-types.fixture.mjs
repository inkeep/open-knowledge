/** @type {Set<number>} */
export const slots = new Set();

/** @type {const} */
export const mode = 'strict';

/**
 * @param {string} name
 * @returns {string}
 */
export function normalize(name) {
  return name.trim();
}

/**
 * @template T
 * @param {T[]} items
 * @returns {T}
 */
export function first(items) {
  return items[0];
}

/** @import { Verdict } from './allowlist.mjs' */
export const usesImport = 1;
