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

export const magicComment = () => import(/* webpackChunkName: "editor" */ './editor.js');

export const viteIgnore = (path: string) => import(/* @vite-ignore */ path);

// prettier-ignore
export const prettierIgnore = [1,2,3];

export const sanctionedTag = 5;

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

// The retracted slot still resolves: precedent #52 kept its number.
export const retractedPrecedent = 14;

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

export const descriptionThenTags = 19;

// entity-ref-preservation
export const lineCommentTag = 20;

//   list-marker-indent
export const indentedTagLine = 21;

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

/** @jsx h */
export const jsxFactoryPragma = 26;

/** @jsxFrag Fragment */
export const jsxFragmentPragma = 27;

/** @jsxRuntime automatic */
export const jsxRuntimePragma = 28;

/** @jsxImportSource preact */
export const jsxImportSourcePragma = 29;

export const webpackExportsMagic = () =>
  import(/* webpackExports: ["parse"] */ './parser.js');

export const webpackFetchPriorityMagic = () =>
  import(/* webpackFetchPriority: "high" */ './urgent.js');

//# sourceMappingURL=must-not-fire.fixture.ts.map
export const sourceMappingUrlPragma = 30;

//# sourceURL=must-not-fire-evaluated.js
export const sourceUrlPragma = 31;
