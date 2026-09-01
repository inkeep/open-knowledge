import { describe, expect, test } from 'vitest';
import {
  BASE16_SLOT_ROLES,
  BASE16_SLOTS,
  type Base16Scheme,
  base16ToTokens,
  base16ToYaml,
  isBase16Hex,
  mixHex,
  parseBase16Scheme,
  relativeLuminance,
} from './base16.ts';

const HEX = /^#[0-9a-f]{6}$/;

/** The upstream Tinted Theming layout, verbatim. */
const CURRENT_LAYOUT = `system: "base16"
name: "Ayu Dark"
author: "Khue Nguyen <Z5483Y@gmail.com>"
variant: "dark"
palette:
  base00: "#0f1419"
  base01: "#131721"
  base02: "#272d38"
  base03: "#3e4b59"
  base04: "#bfbdb6"
  base05: "#e6e1cf"
  base06: "#e6e1cf"
  base07: "#f3f4f5"
  base08: "#f07178"
  base09: "#ff8f40"
  base0A: "#ffb454"
  base0B: "#b8cc52"
  base0C: "#95e6cb"
  base0D: "#59c2ff"
  base0E: "#d2a6ff"
  base0F: "#e6b673"
`;

/** The original chriskempson layout: top-level slots, bare hex, no variant. */
const LEGACY_LAYOUT = `scheme: "Tomorrow Night"
author: "Chris Kempson"
base00: "1d1f21"
base01: "282a2e"
base02: "373b41"
base03: "969896"
base04: "b4b7b4"
base05: "c5c8c6"
base06: "e0e0e0"
base07: "ffffff"
base08: "cc6666"
base09: "de935f"
base0A: "f0c674"
base0B: "b5bd68"
base0C: "8abeb7"
base0D: "81a2be"
base0E: "b294bb"
base0F: "a3685a"
`;

function paletteOf(entries: Partial<Record<string, string>> = {}): Base16Scheme['palette'] {
  const palette = {} as Base16Scheme['palette'];
  for (const [i, slot] of BASE16_SLOTS.entries()) {
    palette[slot] = entries[slot] ?? `#${i.toString(16).repeat(6)}`;
  }
  return palette;
}

describe('slot list', () => {
  test('is the sixteen spec slots in order', () => {
    expect(BASE16_SLOTS).toHaveLength(16);
    expect(BASE16_SLOTS[0]).toBe('base00');
    expect(BASE16_SLOTS[15]).toBe('base0F');
  });

  test('every slot carries a role description', () => {
    for (const slot of BASE16_SLOTS) {
      expect(BASE16_SLOT_ROLES[slot], slot).toBeTruthy();
    }
  });
});

describe('parseBase16Scheme', () => {
  test('reads the current Tinted Theming layout', () => {
    const result = parseBase16Scheme(CURRENT_LAYOUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scheme.name).toBe('Ayu Dark');
    expect(result.scheme.author).toContain('Khue Nguyen');
    expect(result.scheme.variant).toBe('dark');
    expect(result.scheme.palette.base00).toBe('#0f1419');
    expect(result.scheme.palette.base0F).toBe('#e6b673');
  });

  test('reads the legacy layout: top-level slots, bare hex, inferred variant', () => {
    const result = parseBase16Scheme(LEGACY_LAYOUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scheme.palette.base00).toBe('#1d1f21');
    expect(result.scheme.palette.base0A).toBe('#f0c674');
    // No `variant` key — derived from the ramp, background darker than foreground.
    expect(result.scheme.variant).toBe('dark');
  });

  test('infers a light variant when the background is lighter than the foreground', () => {
    const result = parseBase16Scheme(
      JSON.stringify({ name: 'L', palette: paletteOf({ base00: '#fafafa', base05: '#111111' }) }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scheme.variant).toBe('light');
  });

  test('accepts JSON, since YAML is a superset', () => {
    const result = parseBase16Scheme(
      JSON.stringify({ name: 'JSON scheme', variant: 'dark', palette: paletteOf() }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scheme.name).toBe('JSON scheme');
  });

  test('reads unquoted scalars as written, including exponent-shaped hex', () => {
    // A bare legacy hex is ambiguous once YAML types it: `1e5` is valid
    // three-digit hex but reads as the number 100000 under the core schema,
    // and `001122` loses its leading zeros. Reconstructing digits from the
    // parsed number silently yields the wrong color, so the parser keeps
    // scalars as their source text instead.
    const result = parseBase16Scheme(
      [
        'base00: 112233',
        'base01: "#abc"',
        'base02: 001122',
        'base03: 1e5',
        'base04: 0e0',
        ...BASE16_SLOTS.slice(5).map((s) => `${s}: "#010101"`),
      ].join('\n'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scheme.palette.base00).toBe('#112233');
    expect(result.scheme.palette.base01).toBe('#aabbcc');
    expect(result.scheme.palette.base02).toBe('#001122');
    // `1e5` is three-digit hex, not 100000.
    expect(result.scheme.palette.base03).toBe('#11ee55');
    expect(result.scheme.palette.base04).toBe('#00ee00');
  });

  test('names the missing slots rather than failing opaquely', () => {
    const result = parseBase16Scheme('base00: "#111111"\nbase01: "#222222"');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('missing-slots');
    if (result.error.kind !== 'missing-slots') return;
    expect(result.error.slots).toContain('base02');
    expect(result.error.slots).not.toContain('base00');
  });

  test('names the slots whose value is not a color', () => {
    const palette = paletteOf();
    const result = parseBase16Scheme(
      JSON.stringify({ palette: { ...palette, base08: 'rebeccapurple' } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('bad-hex');
    if (result.error.kind !== 'bad-hex') return;
    expect(result.error.slots).toEqual(['base08']);
  });

  test('rejects input that is not a mapping', () => {
    expect(parseBase16Scheme('- a\n- b')).toMatchObject({ error: { kind: 'not-a-scheme' } });
    expect(parseBase16Scheme('')).toMatchObject({ error: { kind: 'not-a-scheme' } });
  });

  test.each([
    ['name', { name: '\u0085', author: 'Ada' }],
    ['author', { name: 'Valid', author: '\u0085' }],
  ])('rejects U+0085 NEXT LINE-only %s metadata', (_field, metadata) => {
    expect(
      parseBase16Scheme(JSON.stringify({ ...metadata, variant: 'dark', palette: paletteOf() })),
    ).toMatchObject({ error: { kind: 'not-a-scheme' } });
  });

  test('rejects unparseable input and names the offending line', () => {
    const result = parseBase16Scheme('{[unclosed');
    expect(result).toMatchObject({ error: { kind: 'unparseable' } });
    if (result.ok || result.error.kind !== 'unparseable') return;
    // A pasted scheme is ~20 lines; without a position the user has nothing to
    // go on but "it didn't parse".
    expect(result.error.line).toBe(1);
  });

  test('an unparseable input with no reported position still classifies', () => {
    // `line` is optional — the parser may reject without a position, and the
    // caller must not depend on it being present.
    const result = parseBase16Scheme('a: b: c: d');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unparseable');
  });

  test('falls back to a usable name when the scheme carries none', () => {
    const result = parseBase16Scheme(JSON.stringify({ palette: paletteOf() }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scheme.name).toBeTruthy();
  });
});

describe('base16ToTokens', () => {
  const scheme: Base16Scheme = { name: 'T', variant: 'dark', palette: paletteOf() };

  test('maps the slots onto their documented roles', () => {
    const t = base16ToTokens(scheme);
    const p = scheme.palette;
    expect(t.background).toBe(p.base00);
    expect(t.foreground).toBe(p.base05);
    expect(t.card).toBe(p.base01);
    expect(t.sidebar).toBe(p.base01);
    expect(t.border).toBe(p.base02);
    // base02 IS the selection slot — no alpha-derived approximation.
    expect(t['selection-soft']).toBe(p.base02);
    expect(t['muted-foreground']).toBe(p.base04);
    expect(t.primary).toBe(p.base0D);
    expect(t.destructive).toBe(p.base08);
    expect(t['syntax-string']).toBe(p.base0B);
    expect(t['syntax-keyword']).toBe(p.base0E);
    expect(t['syntax-comment']).toBe(p.base03);
  });

  test('covers the surfaces that a palette without slot roles could not reach', () => {
    const t = base16ToTokens(scheme);
    // Fifteen callout accents, the lint pair, and sixteen ANSI slots. These
    // are only derivable because the accent slots carry fixed roles; drop one
    // and that surface falls back to a hardcoded literal no theme can override.
    for (const name of [
      'callout-note-color',
      'callout-warning-color',
      'callout-quote-color',
      'lint-warning-color',
      'lint-error-color',
      'broken-link-color',
      'link-color',
      'diff-added',
      'diff-removed',
      'diff-modified',
      'syntax-bg',
    ]) {
      expect(t[name], name).toBeTruthy();
    }
    for (const token of [
      'ansi-black',
      'ansi-red',
      'ansi-green',
      'ansi-yellow',
      'ansi-blue',
      'ansi-magenta',
      'ansi-cyan',
      'ansi-white',
      'ansi-bright-black',
      'ansi-bright-red',
      'ansi-bright-green',
      'ansi-bright-yellow',
      'ansi-bright-blue',
      'ansi-bright-magenta',
      'ansi-bright-cyan',
      'ansi-bright-white',
    ]) {
      expect(t[token], token).toBeTruthy();
    }
  });

  test('spreads the callout accents across distinct slots', () => {
    const t = base16ToTokens(scheme);
    // Adjacent callout types must stay visually distinguishable; collapsing
    // them onto one accent is the failure this guards.
    const accents = new Set([
      t['callout-note-color'],
      t['callout-abstract-color'],
      t['callout-tip-color'],
      t['callout-important-color'],
      t['callout-warning-color'],
      t['callout-caution-color'],
      t['callout-failure-color'],
      t['callout-quote-color'],
    ]);
    expect(accents.size).toBe(8);
  });

  test('emits only literals — a generated theme block cannot carry indirection', () => {
    for (const [name, value] of Object.entries(base16ToTokens(scheme))) {
      expect(value, name).not.toContain('var(');
    }
  });
});

describe('base16ToYaml', () => {
  test('round-trips through the parser', () => {
    // The point of exporting is portability, which only holds if the output is
    // a scheme every base16 tool — including this one — can read back.
    const original = parseBase16Scheme(CURRENT_LAYOUT);
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    const reparsed = parseBase16Scheme(base16ToYaml(original.scheme));
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.scheme).toEqual(original.scheme);
  });

  test('emits the current Tinted Theming layout', () => {
    const yaml = base16ToYaml({ name: 'T', variant: 'light', palette: paletteOf() });
    expect(yaml).toContain('system: "base16"');
    expect(yaml).toContain('name: "T"');
    expect(yaml).toContain('variant: "light"');
    expect(yaml).toContain('palette:');
    for (const slot of BASE16_SLOTS) expect(yaml).toContain(`  ${slot}: "`);
  });

  test('omits author when the scheme has none, and emits it when it does', () => {
    expect(base16ToYaml({ name: 'T', variant: 'dark', palette: paletteOf() })).not.toContain(
      'author:',
    );
    expect(
      base16ToYaml({ name: 'T', author: 'Ada', variant: 'dark', palette: paletteOf() }),
    ).toContain('author: "Ada"');
  });

  test('escapes quotes and backslashes so a hostile name cannot break the document', () => {
    const yaml = base16ToYaml({
      name: 'He said "hi" \\ bye',
      variant: 'dark',
      palette: paletteOf(),
    });
    expect(yaml).toContain('name: "He said \\"hi\\" \\\\ bye"');
    const reparsed = parseBase16Scheme(yaml);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.scheme.name).toBe('He said "hi" \\ bye');
  });

  test('round-trips line breaks, tabs, and control characters in metadata', () => {
    const name = 'Line one\nLine two\twith controls \u0001 and \u007f';
    const author = 'Ada\r\nLovelace\twith controls \u0085 and \u009f plus \u2028 a line separator';
    const yaml = base16ToYaml({
      name,
      author,
      variant: 'dark',
      palette: paletteOf(),
    });

    expect(yaml).toContain('name: "Line one\\nLine two\\twith controls \\u0001 and \\u007f"');
    expect(yaml).toContain(
      'author: "Ada\\r\\nLovelace\\twith controls \\u0085 and \\u009f plus \\u2028',
    );
    const reparsed = parseBase16Scheme(yaml);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.scheme.name).toBe(name);
    expect(reparsed.scheme.author).toBe(author);
  });

  test('preserves intentional leading and trailing whitespace in nonblank metadata', () => {
    const name = '  Padded theme\t';
    const author = '\t Ada Lovelace \n';
    const reparsed = parseBase16Scheme(
      base16ToYaml({ name, author, variant: 'light', palette: paletteOf() }),
    );

    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.scheme.name).toBe(name);
    expect(reparsed.scheme.author).toBe(author);
  });
});

describe('color helpers', () => {
  test('isBase16Hex accepts #rrggbb only', () => {
    expect(isBase16Hex('#0f172a')).toBe(true);
    expect(isBase16Hex('#FFF')).toBe(false);
    expect(isBase16Hex('0f172a')).toBe(false);
    expect(isBase16Hex(42)).toBe(false);
  });

  test('relativeLuminance orders black < mid < white', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    expect(relativeLuminance('#0f172a')).toBeLessThan(relativeLuminance('#f1f5f9'));
  });

  test('mixHex interpolates and always yields a literal hex', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mixHex('#000000', '#ffffff', 0.5)).toMatch(HEX);
    // Out-of-range ratios clamp rather than producing an invalid channel.
    expect(mixHex('#000000', '#ffffff', 5)).toBe('#ffffff');
    expect(mixHex('#000000', '#ffffff', -5)).toBe('#000000');
  });
});
