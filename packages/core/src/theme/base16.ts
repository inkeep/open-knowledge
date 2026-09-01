import { parse as parseYaml } from 'yaml';

export const BASE16_SLOTS = [
  'base00',
  'base01',
  'base02',
  'base03',
  'base04',
  'base05',
  'base06',
  'base07',
  'base08',
  'base09',
  'base0A',
  'base0B',
  'base0C',
  'base0D',
  'base0E',
  'base0F',
] as const;

export type Base16Slot = (typeof BASE16_SLOTS)[number];

export const BASE16_SLOT_ROLES: Record<Base16Slot, string> = {
  base00: 'default background',
  base01: 'alt background — cards, popovers, sidebar',
  base02: 'selection background, borders',
  base03: 'comments, invisibles',
  base04: 'secondary text',
  base05: 'default foreground',
  base06: 'light foreground',
  base07: 'lightest foreground',
  base08: 'red — variables, tags, diff deleted',
  base09: 'orange — numbers, constants',
  base0A: 'yellow — classes, search highlight',
  base0B: 'green — strings, diff inserted',
  base0C: 'cyan — support, escapes, quotes',
  base0D: 'blue — functions, headings, accent',
  base0E: 'magenta — keywords, storage',
  base0F: 'deprecated markers, embedded tags',
};

export type Base16Palette = Record<Base16Slot, string>;

export interface Base16Scheme {
  name: string;
  author?: string;
  variant: 'dark' | 'light';
  palette: Base16Palette;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const HAS_NON_WHITESPACE_RE = /\P{White_Space}/u;

export function containsNonWhitespace(value: string): boolean {
  return HAS_NON_WHITESPACE_RE.test(value);
}

export function isBase16Hex(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value);
}

export function base16ToTokens(scheme: Base16Scheme): Record<string, string> {
  const p = scheme.palette;
  return {
    background: p.base00,
    foreground: p.base05,
    card: p.base01,
    'card-foreground': p.base05,
    popover: p.base01,
    'popover-foreground': p.base05,
    primary: p.base0D,
    'primary-foreground': p.base00,
    secondary: p.base01,
    'secondary-foreground': p.base05,
    muted: p.base01,
    'muted-foreground': p.base04,
    accent: p.base02,
    'accent-foreground': p.base05,
    destructive: p.base08,
    border: p.base02,
    input: p.base02,
    ring: p.base0D,
    'selection-soft': p.base02,

    'chart-1': p.base0D,
    'chart-2': p.base0B,
    'chart-3': p.base0A,
    'chart-4': p.base0E,
    'chart-5': p.base08,

    sidebar: p.base01,
    'sidebar-foreground': p.base05,
    'sidebar-primary': p.base0D,
    'sidebar-primary-foreground': p.base00,
    'sidebar-accent': p.base02,
    'sidebar-accent-foreground': p.base0D,
    'sidebar-hover': p.base02,
    'sidebar-border': p.base02,
    'sidebar-ring': p.base0D,

    'syntax-keyword': p.base0E,
    'syntax-tag': p.base08,
    'syntax-attr': p.base0D,
    'syntax-string': p.base0B,
    'syntax-number': p.base09,
    'syntax-atom': p.base0C,
    'syntax-comment': p.base03,
    'syntax-func': p.base0D,
    'syntax-var': p.base08,
    'syntax-type': p.base0A,
    'syntax-operator': p.base05,
    'syntax-meta': p.base0F,
    'syntax-bg': p.base01,

    'link-color': p.base0D,
    'broken-link-color': p.base08,
    'lint-warning-color': p.base0A,
    'lint-error-color': p.base08,
    'diff-added': p.base0B,
    'diff-removed': p.base08,
    'diff-modified': p.base0D,

    'callout-note-color': p.base0D,
    'callout-info-color': p.base0D,
    'callout-todo-color': p.base0D,
    'callout-abstract-color': p.base0C,
    'callout-tip-color': p.base0B,
    'callout-success-color': p.base0B,
    'callout-important-color': p.base0E,
    'callout-example-color': p.base0E,
    'callout-question-color': p.base0E,
    'callout-warning-color': p.base0A,
    'callout-caution-color': p.base09,
    'callout-danger-color': p.base09,
    'callout-failure-color': p.base08,
    'callout-bug-color': p.base08,
    'callout-quote-color': p.base03,

    ...ansiTokens(p),
  };
}

const ANSI_BY_SLOT = {
  black: 'base00',
  red: 'base08',
  green: 'base0B',
  yellow: 'base0A',
  blue: 'base0D',
  magenta: 'base0E',
  cyan: 'base0C',
  white: 'base05',
  brightBlack: 'base03',
  brightRed: 'base08',
  brightGreen: 'base0B',
  brightYellow: 'base0A',
  brightBlue: 'base0D',
  brightMagenta: 'base0E',
  brightCyan: 'base0C',
  brightWhite: 'base07',
} as const satisfies Record<string, Base16Slot>;

export type AnsiSlotName = keyof typeof ANSI_BY_SLOT;

const ANSI_SLOT_NAMES = Object.keys(ANSI_BY_SLOT) as AnsiSlotName[];

function ansiTokens(p: Base16Palette): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ANSI_SLOT_NAMES) out[`ansi-${kebab(name)}`] = p[ANSI_BY_SLOT[name]];
  return out;
}

function kebab(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function yamlString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029\ufffe\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function base16ToYaml(scheme: Base16Scheme): string {
  const lines = [
    'system: "base16"',
    `name: ${yamlString(scheme.name)}`,
    ...(scheme.author ? [`author: ${yamlString(scheme.author)}`] : []),
    `variant: ${yamlString(scheme.variant)}`,
    'palette:',
    ...BASE16_SLOTS.map((slot) => `  ${slot}: ${yamlString(scheme.palette[slot])}`),
  ];
  return `${lines.join('\n')}\n`;
}

export type Base16ParseError =
  | { kind: 'unparseable'; line?: number }
  | { kind: 'not-a-scheme' }
  | { kind: 'missing-slots'; slots: Base16Slot[] }
  | { kind: 'bad-hex'; slots: Base16Slot[] };

export type Base16ParseResult =
  | { ok: true; scheme: Base16Scheme }
  | { ok: false; error: Base16ParseError };

export function parseBase16Scheme(text: string): Base16ParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(text, { schema: 'failsafe' });
  } catch (error) {
    const linePos = (error as { linePos?: [{ line?: number }] })?.linePos;
    const line = typeof linePos?.[0]?.line === 'number' ? linePos[0].line : undefined;
    return { ok: false, error: { kind: 'unparseable', line } };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: { kind: 'not-a-scheme' } };
  }

  const doc = raw as Record<string, unknown>;
  const nested = doc.palette;
  const source: Record<string, unknown> =
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : doc;

  const palette = {} as Base16Palette;
  const missing: Base16Slot[] = [];
  const badHex: Base16Slot[] = [];
  for (const slot of BASE16_SLOTS) {
    const value = source[slot] ?? source[slot.toLowerCase()];
    if (value === undefined || value === null) {
      missing.push(slot);
      continue;
    }
    const hex = normalizeHex(value);
    if (!hex) {
      badHex.push(slot);
      continue;
    }
    palette[slot] = hex;
  }
  if (missing.length) return { ok: false, error: { kind: 'missing-slots', slots: missing } };
  if (badHex.length) return { ok: false, error: { kind: 'bad-hex', slots: badHex } };
  if (
    (typeof doc.name === 'string' && !containsNonWhitespace(doc.name)) ||
    (typeof doc.author === 'string' && !containsNonWhitespace(doc.author))
  ) {
    return { ok: false, error: { kind: 'not-a-scheme' } };
  }

  return {
    ok: true,
    scheme: {
      name: typeof doc.name === 'string' ? doc.name : 'Imported',
      author: typeof doc.author === 'string' ? doc.author : undefined,
      variant:
        doc.variant === 'light' || doc.variant === 'dark' ? doc.variant : inferVariant(palette),
      palette,
    },
  };
}

function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let s = value.trim();
  if (!s.startsWith('#')) s = `#${s}`;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  return HEX_RE.test(s) ? s.toLowerCase() : null;
}

export function mixHex(a: string, b: string, t: number): string {
  const ca = isBase16Hex(a) ? a : '#000000';
  const cb = isBase16Hex(b) ? b : '#000000';
  const k = Math.min(1, Math.max(0, t));
  let out = '#';
  for (let i = 0; i < 3; i++) {
    const va = Number.parseInt(ca.slice(1 + i * 2, 3 + i * 2), 16);
    const vb = Number.parseInt(cb.slice(1 + i * 2, 3 + i * 2), 16);
    out += Math.round(va + (vb - va) * k)
      .toString(16)
      .padStart(2, '0');
  }
  return out;
}

export function relativeLuminance(hex: string): number {
  const h = isBase16Hex(hex) ? hex : '#000000';
  const channel = (i: number) => {
    const c = Number.parseInt(h.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function inferVariant(p: Base16Palette): 'dark' | 'light' {
  return relativeLuminance(p.base00) < relativeLuminance(p.base05) ? 'dark' : 'light';
}
