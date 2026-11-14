import {
  contrastRatio,
  MINIMUM_CONTRAST_RATIO,
  nearestReading,
} from '@inkeep/open-knowledge-core/theme/base16';
import { useEffect, useState } from 'react';
import { readDocumentColorMode } from '@/editor/components/use-app-color-mode';
import { subscribeColorThemeEpoch } from '@/lib/color-theme-epoch';
import { themeColorTransitionsActive } from '@/lib/theme-color-transitions';
import { readTokenColors } from '@/lib/theme-token-colors';

export interface GraphPalette {
  readonly background: string;
  readonly foreground: string;
  readonly muted: string;
  readonly primary: string;
  readonly success: string;
  readonly warning: string;
  readonly destructive: string;
  readonly folder: string;
  readonly clusters: readonly string[];
}

const CLUSTER_TOKENS = [
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--identity-2',
  '--identity-3',
  '--identity-4',
] as const;

const GRAPH_TOKENS = [
  '--background',
  '--foreground',
  '--muted-foreground',
  '--primary',
  '--success',
  '--warning',
  '--destructive',
  ...CLUSTER_TOKENS,
] as const;

type GraphToken = (typeof GRAPH_TOKENS)[number];

export type GraphTokenReader = (token: GraphToken) => string | null;

const FALLBACK_SURFACES = {
  light: { background: '#ffffff', foreground: '#0a0a0a' },
  dark: { background: '#181818', foreground: '#fafafa' },
} as const;

function opaqueHex(color: string): string | null {
  const match = /^#([0-9a-f]{6})(ff)?$/i.exec(color);
  return match === null ? null : `#${match[1].toLowerCase()}`;
}

export function visibleOn(color: string, surface: string, toward: string): string {
  const fill = opaqueHex(color);
  const page = opaqueHex(surface);
  const end = opaqueHex(toward);
  if (fill === null || page === null || end === null) return color;
  const reads = (candidate: string) =>
    contrastRatio(candidate, page) >= MINIMUM_CONTRAST_RATIO.graphical;
  return nearestReading(fill, end, reads) ?? end;
}

export function fallbackGraphPalette(mode: 'light' | 'dark'): GraphPalette {
  const { background, foreground } = FALLBACK_SURFACES[mode];
  return {
    background,
    foreground,
    muted: foreground,
    primary: foreground,
    success: foreground,
    warning: foreground,
    destructive: foreground,
    folder: foreground,
    clusters: CLUSTER_TOKENS.map(() => foreground),
  };
}

export function graphPaletteFrom(
  readToken: GraphTokenReader,
  previous: GraphPalette,
): GraphPalette {
  const surface = readToken('--background');
  const text = readToken('--foreground');
  const [background, foreground] =
    surface !== null && text !== null
      ? [surface, text]
      : [previous.background, previous.foreground];
  const visible = (token: GraphToken, kept: string) =>
    visibleOn(readToken(token) ?? kept, background, foreground);
  return {
    background,
    foreground,
    muted: visible('--muted-foreground', previous.muted),
    primary: visible('--primary', previous.primary),
    success: visible('--success', previous.success),
    warning: visible('--warning', previous.warning),
    destructive: visible('--destructive', previous.destructive),
    folder: visible('--chart-4', previous.folder),
    clusters: CLUSTER_TOKENS.map((token, index) => visible(token, previous.clusters[index])),
  };
}

let reportedUnresolved = '';

function readDocumentTokens(): GraphTokenReader {
  const colors = readTokenColors(GRAPH_TOKENS);
  const readToken: GraphTokenReader = (token) => colors.get(token) ?? null;
  const unresolved = GRAPH_TOKENS.filter((token) => readToken(token) === null).join(' ');
  if (unresolved !== reportedUnresolved) {
    reportedUnresolved = unresolved;
    if (unresolved !== '') {
      console.warn(
        JSON.stringify({ event: 'graph-palette-tokens-unresolved', tokens: unresolved }),
      );
    }
  }
  return readToken;
}

function samePalette(a: GraphPalette, b: GraphPalette): boolean {
  return (Object.keys(a) as (keyof GraphPalette)[]).every((key) => {
    const left = a[key];
    const right = b[key];
    if (typeof left === 'string' || typeof right === 'string') return left === right;
    return left.length === right.length && left.every((color, index) => color === right[index]);
  });
}

export function useGraphPalette(): GraphPalette {
  const [palette, setPalette] = useState(() =>
    graphPaletteFrom(readDocumentTokens(), fallbackGraphPalette(readDocumentColorMode())),
  );

  useEffect(() => {
    const refresh = () => {
      if (themeColorTransitionsActive()) return;
      const readToken = readDocumentTokens();
      setPalette((previous) => {
        const next = graphPaletteFrom(readToken, previous);
        return samePalette(previous, next) ? previous : next;
      });
    };
    refresh();
    return subscribeColorThemeEpoch(refresh);
  }, []);

  return palette;
}

export function withAlpha(color: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  if (match === null) return color;
  const own = match[2] === undefined ? 1 : Number.parseInt(match[2], 16) / 255;
  const byte = Math.round(Math.min(1, Math.max(0, own * alpha)) * 255);
  return `#${match[1]}${byte.toString(16).padStart(2, '0')}`;
}
