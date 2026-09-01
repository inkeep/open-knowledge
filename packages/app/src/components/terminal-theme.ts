import type { AnsiSlotName } from '@inkeep/open-knowledge-core';
import type { ITheme } from '@xterm/xterm';

export const XTERM_DARK_THEME = {
  background: '#171717',
  foreground: '#e5e5e5',
  cursor: '#e5e5e5',
  cursorAccent: '#171717',
  selectionBackground: '#3a3d41',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
} satisfies ITheme;

export const XTERM_LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#262626',
  cursor: '#262626',
  cursorAccent: '#ffffff',
  selectionBackground: '#add6ff',
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5',
} satisfies ITheme;

export function xtermThemeForMode(resolvedTheme: string | undefined): ITheme {
  return resolvedTheme === 'dark' ? XTERM_DARK_THEME : XTERM_LIGHT_THEME;
}

export type TokenColorReader = (token: string) => string | null;

function normalizeProbedColor(resolved: string | undefined): string | null {
  if (!resolved || resolved === 'rgba(0, 0, 0, 0)' || resolved === 'transparent') return null;
  if (resolved.includes('var(')) return null;
  return resolved;
}

function readTokenColors(tokens: readonly string[]): Map<string, string | null> {
  const resolved = new Map<string, string | null>();
  if (typeof document === 'undefined' || !document.body) return resolved;

  const fragment = document.createDocumentFragment();
  const probes = tokens.map((token) => {
    const probe = document.createElement('span');
    probe.style.display = 'none';
    probe.style.backgroundColor = `var(${token})`;
    fragment.appendChild(probe);
    return { token, probe };
  });
  document.body.appendChild(fragment);
  try {
    for (const { token, probe } of probes) {
      resolved.set(token, normalizeProbedColor(getComputedStyle(probe).backgroundColor));
    }
  } finally {
    for (const { probe } of probes) probe.remove();
  }
  return resolved;
}

const ANSI_TOKEN_BY_SLOT: Record<AnsiSlotName, string> = {
  black: '--ansi-black',
  red: '--ansi-red',
  green: '--ansi-green',
  yellow: '--ansi-yellow',
  blue: '--ansi-blue',
  magenta: '--ansi-magenta',
  cyan: '--ansi-cyan',
  white: '--ansi-white',
  brightBlack: '--ansi-bright-black',
  brightRed: '--ansi-bright-red',
  brightGreen: '--ansi-bright-green',
  brightYellow: '--ansi-bright-yellow',
  brightBlue: '--ansi-bright-blue',
  brightMagenta: '--ansi-bright-magenta',
  brightCyan: '--ansi-bright-cyan',
  brightWhite: '--ansi-bright-white',
};

const LIVE_THEME_TOKENS: readonly string[] = [
  '--background',
  '--foreground',
  '--selection-soft',
  ...Object.values(ANSI_TOKEN_BY_SLOT),
];

function createBatchedTokenReader(): TokenColorReader {
  const batch = readTokenColors(LIVE_THEME_TOKENS);
  return (token) => batch.get(token) ?? null;
}

export function computeLiveXtermTheme(
  resolvedTheme: string | undefined,
  readToken: TokenColorReader = createBatchedTokenReader(),
): ITheme {
  const base = xtermThemeForMode(resolvedTheme);
  const background = readToken('--background') ?? base.background;
  const foreground = readToken('--foreground') ?? base.foreground;

  const ansi: Partial<Record<AnsiSlotName, string>> = {};
  for (const slot of Object.keys(ANSI_TOKEN_BY_SLOT) as AnsiSlotName[]) {
    const resolved = readToken(ANSI_TOKEN_BY_SLOT[slot]);
    if (resolved) ansi[slot] = resolved;
  }

  return {
    ...base,
    ...ansi,
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: readToken('--selection-soft') ?? base.selectionBackground,
  };
}
