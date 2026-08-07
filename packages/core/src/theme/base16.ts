/**
 * base16 — the interchange format every OK color theme is authored in.
 *
 * Sixteen slots: `base00`–`base07` are shades of one tone (backgrounds through
 * foregrounds), `base08`–`base0F` are the accents. The ordering of the tonal
 * ramp flips with `variant` — dark schemes run base00 (darkest) → base07
 * (lightest), light schemes run the other way.
 *
 * Two properties earn the format its place over a bespoke one:
 *
 *  1. The accent slots have fixed *roles*, not fixed hues — `base08` is
 *     "variables / tags / diff-deleted" and conventionally red, `base0B` is
 *     "strings / diff-inserted" and conventionally green. That role fixing is
 *     what lets one scheme drive syntax highlighting, callout accents, lint
 *     squigglies and the terminal's 16 ANSI slots from a single source.
 *  2. The slots map onto ANSI, so a scheme is directly expressible as a
 *     terminal palette (the `--ansi-*` tokens below). A palette keyed by
 *     app-semantic names ("primary", "surface") is not, which is what keeps a
 *     terminal's sixteen slots reachable from a theme at all.
 *
 * Reference: the Tinted Theming styling guidelines (base16 v0.4.2).
 */

import { parse as parseYaml } from 'yaml';

/** The sixteen slots, in spec order. Iteration order is stable for CSS generation. */
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

/**
 * Short human role per slot, for config-field descriptions and the settings
 * editor's swatch labels. Kept beside the slot list so a reader of either
 * surface sees the same wording.
 */
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

/**
 * Sixteen `#rrggbb` values. Slot roles, per the styling guidelines:
 *
 * | slot   | ANSI            | role                                                     |
 * | ------ | --------------- | -------------------------------------------------------- |
 * | base00 | black           | default background                                        |
 * | base01 | —               | lighter/alt background — status bars, cards, sidebar      |
 * | base02 | —               | selection background                                      |
 * | base03 | bright black    | comments, invisibles, line highlighting                    |
 * | base04 | —               | dark foreground — status bars, secondary text             |
 * | base05 | white           | default foreground, caret, delimiters, operators           |
 * | base06 | —               | light foreground                                          |
 * | base07 | bright white    | lightest foreground                                       |
 * | base08 | red             | variables, tags, markup lists, diff deleted               |
 * | base09 | —               | integers, booleans, constants, markup link url            |
 * | base0A | yellow          | classes, markup bold, search highlight                    |
 * | base0B | green           | strings, inherited class, markup code, diff inserted      |
 * | base0C | cyan            | support, regexes, escape characters, markup quotes        |
 * | base0D | blue            | functions, methods, attribute ids, headings               |
 * | base0E | magenta         | keywords, storage, selectors, markup italic, diff changed |
 * | base0F | —               | deprecated, embedded-language tags                        |
 */
export type Base16Palette = Record<Base16Slot, string>;

/** A scheme: the palette plus the metadata the spec's YAML files carry. */
export interface Base16Scheme {
  /** Display name, e.g. `Dracula`. A brand proper-noun — not translated. */
  name: string;
  /** Credit line from the upstream scheme, when it has one. */
  author?: string;
  /**
   * Which end of the tonal ramp `base00` sits at. Also the light/dark mode the
   * theme forces, so Tailwind `dark:` variants and `color-scheme` stay correct.
   */
  variant: 'dark' | 'light';
  palette: Base16Palette;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const HAS_NON_WHITESPACE_RE = /\P{White_Space}/u;

/** True when a metadata scalar is not solely Unicode White_Space characters. */
export function containsNonWhitespace(value: string): boolean {
  return HAS_NON_WHITESPACE_RE.test(value);
}

export function isBase16Hex(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value);
}

/**
 * Map a scheme onto the app's CSS custom properties (token name → value, keyed
 * without the leading `--`). Insertion order is stable so generated CSS diffs
 * stay readable.
 *
 * Surface derivation uses `base01` for every elevated surface — cards,
 * popovers, sidebar. Real schemes disagree on whether `base01` sits lighter or
 * darker than `base00` (Dracula and Catppuccin author it darker even though
 * both are dark schemes), so treating it as "a distinct shade of the same
 * tone" rather than "one step lighter" is the only reading that holds across
 * the ecosystem. Either direction reads as a separate surface.
 */
export function base16ToTokens(scheme: Base16Scheme): Record<string, string> {
  const p = scheme.palette;
  return {
    // --- shadcn core -------------------------------------------------------
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
    // base02 *is* the selection background by definition — no alpha-derived
    // approximation needed the way a palette without the slot required.
    'selection-soft': p.base02,

    // --- charts ------------------------------------------------------------
    'chart-1': p.base0D,
    'chart-2': p.base0B,
    'chart-3': p.base0A,
    'chart-4': p.base0E,
    'chart-5': p.base08,

    // --- sidebar / chrome --------------------------------------------------
    sidebar: p.base01,
    'sidebar-foreground': p.base05,
    'sidebar-primary': p.base0D,
    'sidebar-primary-foreground': p.base00,
    'sidebar-accent': p.base02,
    'sidebar-accent-foreground': p.base0D,
    'sidebar-hover': p.base02,
    'sidebar-border': p.base02,
    'sidebar-ring': p.base0D,

    // --- syntax ------------------------------------------------------------
    'syntax-keyword': p.base0E,
    'syntax-tag': p.base08,
    'syntax-attr': p.base0D,
    'syntax-string': p.base0B,
    'syntax-number': p.base09,
    'syntax-atom': p.base0C,
    // Slots the previous palette had no room for. These are what let the
    // source editor and fenced code blocks drop their hardcoded highlight
    // styles.
    'syntax-comment': p.base03,
    'syntax-func': p.base0D,
    'syntax-var': p.base08,
    'syntax-type': p.base0A,
    'syntax-operator': p.base05,
    'syntax-meta': p.base0F,
    'syntax-bg': p.base01,

    // --- editor affordances ------------------------------------------------
    'link-color': p.base0D,
    'broken-link-color': p.base08,
    'lint-warning-color': p.base0A,
    'lint-error-color': p.base08,
    'diff-added': p.base0B,
    'diff-removed': p.base08,

    // --- callouts ----------------------------------------------------------
    // Spread across all eight accents so adjacent types stay distinguishable;
    // `quote` takes the comment slot to keep its deliberate near-gray.
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

    // --- terminal ----------------------------------------------------------
    // Emitted as tokens rather than resolved in TS so the terminal picks them
    // up through the same live-token read it already uses for its surfaces,
    // and so custom schemes work with no extra plumbing.
    ...ansiTokens(p),
  };
}

/** xterm's `ITheme` ANSI slot names, in the order the spec's table lists them. */
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

/** `--ansi-*` custom properties, keyed without the leading `--`. */
function ansiTokens(p: Base16Palette): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ANSI_SLOT_NAMES) out[`ansi-${kebab(name)}`] = p[ANSI_BY_SLOT[name]];
  return out;
}

/** `brightBlack` → `bright-black`; the ANSI names are the only camelCase input. */
function kebab(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

/** Double-quoted YAML scalar — the one form that needs no context to be safe. */
function yamlString(value: string): string {
  // JSON handles C0 controls, quotes, backslashes, and lone surrogates. Escape
  // the remaining YAML line/control characters that JSON may emit literally.
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029\ufffe\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * Serialize a scheme back to base16 YAML, in the current Tinted Theming
 * layout. Round-trips through {@link parseBase16Scheme}.
 *
 * The point is portability: a scheme a user tuned here should be pasteable
 * into any other base16-aware tool, not trapped in OK's config.
 */
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

/** Why a pasted scheme was rejected, for a field-level error message. */
export type Base16ParseError =
  /** `line` is the 1-based YAML line the parser rejected, when it reported one. */
  | { kind: 'unparseable'; line?: number }
  | { kind: 'not-a-scheme' }
  | { kind: 'missing-slots'; slots: Base16Slot[] }
  | { kind: 'bad-hex'; slots: Base16Slot[] };

export type Base16ParseResult =
  | { ok: true; scheme: Base16Scheme }
  | { ok: false; error: Base16ParseError };

/**
 * Parse a pasted scheme. Accepts the current Tinted Theming layout (`palette:`
 * nested, `#`-prefixed hex, `variant`) and the original chriskempson layout
 * (slots at the top level, bare hex, no `variant`) — both are widely published,
 * so accepting only one would reject roughly half the ecosystem. JSON parses
 * too, since YAML is a superset.
 *
 * `variant` is inferred when absent by comparing the tonal ramp's endpoints:
 * dark schemes run base00 darker than base05.
 */
export function parseBase16Scheme(text: string): Base16ParseResult {
  let raw: unknown;
  try {
    // The failsafe schema resolves every scalar to a string. That matters
    // because a bare legacy hex is ambiguous once YAML has typed it: `1e5` is
    // valid three-digit hex, but the core schema reads it as the number 100000
    // and the original digits are then unrecoverable. Keeping scalars as
    // written removes the whole class rather than guessing per-shape.
    raw = parseYaml(text, { schema: 'failsafe' });
  } catch (error) {
    // `yaml` throws a YAMLParseError carrying `linePos`; a scheme is ~20 lines,
    // so naming the line is the difference between a fixable error and a shrug.
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
    // The legacy layout is case-sensitive about `base0A`-`base0F`, but hand-
    // edited files drift to lowercase; accept either rather than fail on case.
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

/**
 * Accept `#rrggbb`, bare `rrggbb` (the legacy layout), and `#rgb`.
 *
 * Values arrive as their source text (see the failsafe parse above), so an
 * unquoted legacy hex needs no un-coercion — `112233`, `001122` and `1e5` all
 * read as written.
 */
function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let s = value.trim();
  if (!s.startsWith('#')) s = `#${s}`;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  return HEX_RE.test(s) ? s.toLowerCase() : null;
}

/**
 * Blend two `#rrggbb` colors in sRGB, `t` of the way from `a` to `b`.
 *
 * Deliberately not `color-mix()`: every slot of a `Base16Palette` must be a
 * literal hex, because consumers that can't resolve CSS — xterm's ANSI slots
 * and the settings swatches, which paint outside the cascade on purpose — read
 * the palette directly.
 */
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

/** sRGB relative luminance (WCAG), 0 (black) … 1 (white). */
export function relativeLuminance(hex: string): number {
  const h = isBase16Hex(hex) ? hex : '#000000';
  const channel = (i: number) => {
    const c = Number.parseInt(h.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** A scheme is dark when its background reads darker than its foreground. */
function inferVariant(p: Base16Palette): 'dark' | 'light' {
  return relativeLuminance(p.base00) < relativeLuminance(p.base05) ? 'dark' : 'light';
}
