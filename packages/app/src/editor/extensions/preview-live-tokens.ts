import { PREVIEW_THEME_TOKENS } from '@inkeep/open-knowledge-core';
import { COLOR_THEME_ATTRIBUTE } from '@/lib/use-apply-config-color-theme';

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

const PREVIEW_FORWARDED_TOKENS: readonly string[] = [
  ...PREVIEW_THEME_TOKENS.map((token) => token.name),
  ...EXTRA_PREVIEW_TOKENS,
];

export interface PreviewTokenEnv {
  paletteActive: boolean;
  readToken: (name: string) => string | null;
}

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

export function readLivePreviewTokens(
  env: PreviewTokenEnv | null = domPreviewTokenEnv(),
): Record<string, string> | null {
  if (!env) return null;
  if (!env.paletteActive) return {};
  const out: Record<string, string> = {};
  for (const name of PREVIEW_FORWARDED_TOKENS) {
    const value = env.readToken(name);
    if (!value || value.includes('var(')) continue;
    out[name] = value;
  }
  return out;
}

export function renderTokenDecls(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `${name}:${value}`)
    .join(';');
}
