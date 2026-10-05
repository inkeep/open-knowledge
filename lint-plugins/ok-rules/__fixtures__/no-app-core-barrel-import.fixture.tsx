// biome-ignore-all assist/source/organizeImports: each import form is a separate positive or negative case; merging or reordering them would erase cases and shift the asserted positions
// FIXTURE — drives `no-app-core-barrel-import.uncached.test.mjs` via shell-out to oxlint.
// Not part of the main lint: `__fixtures__/` is in `oxlint.config.ts#ignorePatterns`, and
// `__fixtures__/oxlint.fixtures.json` re-enables the rules for the test.
//
// Positive cases (one per line, each prefixed `p`): every module-reference form that names
// the bare core barrel, with or without a `?query` or `#hash` suffix. Negative cases (prefixed `n`): the adjacent shapes the rule must NOT
// match — declared subpaths, sibling packages sharing the prefix, the barrel name inside a
// string or a comment, and non-literal or member-call loads.

// === Positive cases — must fire ===

import { sharedExtensions } from '@inkeep/open-knowledge-core'; // p value
import type { LinterConfig } from '@inkeep/open-knowledge-core'; // p whole-declaration type
import { THEME_PLUGINS, type ThemePlugin } from '@inkeep/open-knowledge-core'; // p mixed
import * as coreNamespace from '@inkeep/open-knowledge-core'; // p namespace
import '@inkeep/open-knowledge-core'; // p side-effect
import coreDefault from '@inkeep/open-knowledge-core'; // p default
import coreRequired = require('@inkeep/open-knowledge-core'); // p TS import-equals
export { FORM_WRITE_ORIGIN } from '@inkeep/open-knowledge-core'; // p named re-export
export type { ConfigSchema } from '@inkeep/open-knowledge-core'; // p type re-export
export * from '@inkeep/open-knowledge-core'; // p star re-export
export * as coreStar from '@inkeep/open-knowledge-core'; // p star-as re-export
export type CoreModule = typeof import('@inkeep/open-knowledge-core'); // p typeof import type
export type CoreLinter = import('@inkeep/open-knowledge-core').LinterConfig; // p import type
export const pDynamic = () => import('@inkeep/open-knowledge-core'); // p literal dynamic import
export const pTemplate = () => import(`@inkeep/open-knowledge-core`); // p template, no expressions
export const pRequire = () => require('@inkeep/open-knowledge-core'); // p literal require
import coreRaw from '@inkeep/open-knowledge-core?raw'; // p query suffix
import '@inkeep/open-knowledge-core?v=1'; // p cache-busting query on a side-effect import
export const pHash = () => import('@inkeep/open-knowledge-core#entry'); // p hash suffix

// === Negative cases — must NOT fire ===

import { getGitHubStars } from '@inkeep/open-knowledge-core/utils/github-stars'; // n subpath
import type { CheckpointKind } from '@inkeep/open-knowledge-core/constants/checkpoint-kinds'; // n type subpath
import { startServer } from '@inkeep/open-knowledge-core/server'; // n pre-existing subpath
import { bootServer } from '@inkeep/open-knowledge-server'; // n sibling package
import { cliMain } from '@inkeep/open-knowledge'; // n prefix of the barrel name
import { extra } from '@inkeep/open-knowledge-core-extra'; // n longer package sharing the prefix
export { SHOW_INSTALL_SKILL } from '@inkeep/open-knowledge-core/constants/feature-flags'; // n subpath re-export
export * from '@inkeep/open-knowledge-core/bridge'; // n subpath star re-export
export type BridgeModule = typeof import('@inkeep/open-knowledge-core/bridge'); // n subpath import type
export const nDynamic = () => import('@inkeep/open-knowledge-core/markdown/lint'); // n subpath dynamic import
export const nRequire = () => require('@inkeep/open-knowledge-core/bridge'); // n subpath require
import bridgeRaw from '@inkeep/open-knowledge-core/bridge?raw'; // n subpath with a query suffix
import extraVersioned from '@inkeep/open-knowledge-core-extra?v=1'; // n longer package with a query suffix
export const nString = '@inkeep/open-knowledge-core'; // n ordinary string literal
export const nMessage = `install @inkeep/open-knowledge-core`; // n template containing the name
// n the comment names '@inkeep/open-knowledge-core' and must not fire
export const nComputed = (suffix: string) => import(`@inkeep/open-knowledge-core${suffix}`); // n computed
export const nMember = (loader: { require(id: string): unknown }) =>
  loader.require('@inkeep/open-knowledge-core'); // n member call, not the require builtin

export const used = [
  sharedExtensions,
  THEME_PLUGINS,
  coreNamespace,
  coreDefault,
  coreRequired,
  coreRaw,
  bridgeRaw,
  extraVersioned,
  getGitHubStars,
  startServer,
  bootServer,
  cliMain,
  extra,
];
export type UsedType = LinterConfig | ThemePlugin | CheckpointKind;
