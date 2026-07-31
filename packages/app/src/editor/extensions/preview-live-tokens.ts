/**
 * Live design-token reads for the preview iframe.
 *
 * A preview runs at a null origin (`sandbox="allow-scripts"` without
 * `allow-same-origin`), so it inherits nothing from the host page — its tokens
 * have to be baked into the `srcDoc` or pushed over `postMessage`. The baked
 * set comes from `PREVIEW_THEME_TOKENS`, a build-time snapshot of the DEFAULT
 * theme, which is why an embed used to render on neutral-black next to a
 * Dracula editor.
 *
 * Reading the host's computed values instead means an embed tracks whichever
 * color theme is active, including a user-imported one that didn't exist at
 * build time. The snapshot stays as the fallback for environments where
 * `getComputedStyle` can't resolve custom properties (tests, SSR).
 */

import { PREVIEW_THEME_TOKENS } from '@inkeep/open-knowledge-core';
import { COLOR_THEME_ATTRIBUTE } from '@/lib/use-apply-config-color-theme';

/**
 * Tokens forwarded on top of the snapshot set. The snapshot covers charts and
 * the core surface pair; these are the ones an embed reaches for next —
 * elevated surfaces, interactive accents, and the syntax colors a code-shaped
 * embed needs.
 */
const EXTRA_PREVIEW_TOKENS = [
  '--popover',
  '--popover-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--accent',
  '--accent-foreground',
  '--input',
  '--ring',
  '--selection-soft',
  '--syntax-keyword',
  '--syntax-string',
  '--syntax-number',
  '--syntax-comment',
  '--syntax-func',
  '--syntax-bg',
] as const;

/** Every custom property a preview iframe receives, snapshot set first. */
const PREVIEW_FORWARDED_TOKENS: readonly string[] = [
  ...PREVIEW_THEME_TOKENS.map((token) => token.name),
  ...EXTRA_PREVIEW_TOKENS,
];

/**
 * The host state token forwarding depends on. Injectable for the same reason
 * `computeLiveXtermTheme` takes a `TokenColorReader`: it keeps the mapping
 * testable without standing up a DOM substrate.
 */
export interface PreviewTokenEnv {
  /** Whether a color theme is selected — i.e. `data-color-theme` is present. */
  paletteActive: boolean;
  /** Resolve one custom property to a concrete value, or null when unset. */
  readToken: (name: string) => string | null;
}

/** The live host environment, or `null` when there is no document to read. */
export function domPreviewTokenEnv(): PreviewTokenEnv | null {
  if (typeof document === 'undefined') return null;
  const root = document.documentElement;
  return {
    paletteActive: root.hasAttribute(COLOR_THEME_ATTRIBUTE),
    readToken: (name) => {
      try {
        return getComputedStyle(root).getPropertyValue(name).trim() || null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Resolve the forwarded tokens against the host.
 *
 * Returns an EMPTY map when no color theme is selected, which is meaningfully
 * different from returning values: the baked light/dark blocks carry the
 * default theme correctly and can flip with the iframe's own `.dark` class,
 * whereas a live override is mode-agnostic and would pin the embed to whatever
 * mode was active when it mounted. Only a selected palette — which forces its
 * own mode anyway — should override them.
 *
 * Returns `null` only when there is no host to read.
 */
export function readLivePreviewTokens(
  env: PreviewTokenEnv | null = domPreviewTokenEnv(),
): Record<string, string> | null {
  if (!env) return null;
  if (!env.paletteActive) return {};
  const out: Record<string, string> = {};
  for (const name of PREVIEW_FORWARDED_TOKENS) {
    const value = env.readToken(name);
    // A value still containing `var(` means the environment didn't resolve the
    // chain and would be meaningless inside the null-origin frame.
    if (!value || value.includes('var(')) continue;
    out[name] = value;
  }
  return out;
}

/** Render a token map as `--name:value;` declarations. */
export function renderTokenDecls(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `${name}:${value}`)
    .join(';');
}
