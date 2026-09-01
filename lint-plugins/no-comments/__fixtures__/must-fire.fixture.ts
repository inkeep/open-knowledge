// A plain prose comment explaining what the next line does.
export const plain = 1;

/**
 * A JSDoc prose block with no sanctioned tag and no directive.
 * It narrates the function instead of letting the name carry it.
 */
export function jsdocProse(): number {
  return plain;
}

// ──────────────────────────── section divider ────────────────────────────
export const afterDivider = 2;

// TODO: wire this up once the upstream API stabilises
export const todo = 3;

// @ts-ignore
export const bannedDirective = 4;

// we should biome-ignore this rule later, once the a11y backlog clears
export const disguisedDisable = 5;

// @ts-expect-error
export const unreasonedDirective = 6;

// UPSTREAM(some vague place): the platform does something odd here
export const badReferent = 7;

// STOP: keep this aligned with the sibling module, per D5
export const rotInSurvivor = 8;

/** @lintignore */
export const unreasonedLintignore = 9;

// we should add here someday
export const launderedTagAppend = 10;

export const launderedTagInline = 11;

/**
 * Architectural floor: `entity-ref-preservation`
 */
export const backtickedTag = 12;

/**
 * Long rationale paragraph.
 * More rationale, so no collision (`pua-sentinel-ranges-reserved`).
 */
export const parentheticalTag = 13;

// Architectural floor: blank-line-count-normalization
export const prosePrefixedTag = 14;

// a prose line that names no tag at all
export const tagPrefixCollision = 15;

// `blank-line-count-normalization`). No-op when nodes lack
export const backtickedStump = 16;

// STOP: a multi-line marker must be a block comment; the next line is
// prose to the gate, not a continuation of this marker
export const markerContinuation = 17;

// we should mark that @deprecated once the v3 API lands
export const launderedDeprecatedAppend = 18;

/** long prose narrating the module @deprecated maybe */
export const launderedDeprecatedInline = 19;

// see the `@deprecated` discussion in the RFC thread
export const launderedDeprecatedBackticked = 20;
