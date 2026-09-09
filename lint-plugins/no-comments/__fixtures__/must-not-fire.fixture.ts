/// <reference types="vite/client" />
// @vitest-environment jsdom
// @ts-nocheck
// SPDX-License-Identifier: GPL-3.0-or-later

// biome-ignore lint/a11y/noStaticElementInteractions: pointer clicks only
export const biomeIgnore = 1;

/* oxlint-disable unicorn/no-thenable -- `then` is a JSON Schema keyword */
export const oxlintDisable = 2;

// eslint-disable-next-line no-console
export const eslintDisable = 3;

// @ts-expect-error the stub omits the optional field on purpose
export const tsExpectError = 4;

export const pureAnnotation = /* @__PURE__ */ Object.freeze({ a: 1 });

export const viteIgnore = (path: string) => import(/* @vite-ignore */ path);

/** @deprecated use `sanctionedTag` instead */
export const deprecated = 6;

// STOP: the two catalogs are index-aligned; reorder one and the other must follow
export const stopMarker = 7;

// WARN: the sibling module derives its offsets from this constant
export const warnMarker = 8;

// UPSTREAM(electron/electron#19920): focus() alone never foregrounds; keep activate+moveTop
export const upstreamIssue = 9;

// UPSTREAM(RFC 9457): the envelope members are flat, not nested under `extensions`
export const upstreamRfc = 10;

// UPSTREAM(CommonMark §4.4): an indented chunk inside a list item is a code block
export const upstreamCommonMark = 11;

// UPSTREAM(yjs@13.6.27): transaction origins are compared by identity, not value
export const upstreamPackage = 12;

// The alignment here follows precedent #42.
export const validPrecedent = 13;

// error-log-shape-ok: the message snapshot is the assertion subject here
export const errorLogShapeOk = 15;

/**
 * A documented exemption from Precedent #30 lives here so the invariant guard
 * can find and strip it.
 */
export const guardMarker = 16;

/** @lintignore union member of the exported result type; no direct importer */
export const knipLintignore = 17;

// presence-exempt: no CRDT write, no agent identity
export const presenceExempt = 18;

/* STOP: a multi-line marker in block form survives whole, because the
   extractor reads the block as one comment and the marker is its first
   body line. */
export const blockFormMarker = 22;

/**
 * UPSTREAM(RFC 9457): a JSDoc-form marker reaches editor hover at every
 * consumer, which is the shape for markers on exported surfaces.
 */
export const jsdocFormMarker = 23;

/* @__NO_SIDE_EFFECTS__ */
export function noSideEffects() {
  return 24;
}

/* #__NO_SIDE_EFFECTS__ */
export function noSideEffectsHashForm() {
  return 25;
}

/** @jsxRuntime automatic */
export const jsxRuntimePragma = 28;

/** @jsxImportSource preact */
export const jsxImportSourcePragma = 29;

export const bundlerIgnore = (path: string) => import(/* webpackIgnore: true */ path);

export const turbopackIgnore = (path: string) => import(/* turbopackIgnore: true */ path);

export const turbopackOptional = () => import(/* turbopackOptional: true */ './maybe.js');

//! Bundled banner text the bundler preserves verbatim in the output.
export const legalLineComment = 26;

/*! Bundled banner in block form, preserved on the same rule. */
export const legalBlockComment = 27;
