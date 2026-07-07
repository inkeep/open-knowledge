/**
 * Co-located unit tests for the per-descriptor static fallback palette.
 *
 * The palette is a parallel descriptor registry — `paletteFor` switches on
 * `componentName` and returns hand-built DOM elements for the canonical
 * + compat descriptor pack. A new descriptor added to the registry without
 * a palette entry would silently produce `null` here, which the walker
 * appends as a no-op — Activity-hidden copies would lose the descriptor
 * entirely.
 *
 * bun-test has no DOM (`document.createElement` is unavailable), so the
 * DOM-shape behavior of the palette functions is covered by Playwright
 * E2E. This file pins the **structural** contracts that are testable
 * without a DOM:
 *
 * - `PALETTE_DESCRIPTOR_NAMES` covers every canonical / compat descriptor.
 * - `toneForType` resolves known types and falls back safely for unknown /
 *   prototype-pollution-style names.
 * - `TYPE_TO_TONE` shape pins the supported callout type set.
 */

import { describe, expect, test } from 'bun:test';
import { classifyUrlPortability } from './clipboard-sanitize.ts';
import {
  PALETTE_DESCRIPTOR_NAMES,
  paletteUrlReason,
  TYPE_TO_TONE,
  toneForType,
} from './clipboard-walker-fallback-palette.ts';

describe('PALETTE_DESCRIPTOR_NAMES — registry coverage', () => {
  test('covers every canonical descriptor', () => {
    // Adding a new canonical descriptor to the registry requires adding
    // a case here — without it, Activity-hidden cross-app paste would
    // silently lose the descriptor.
    expect([...PALETTE_DESCRIPTOR_NAMES]).toEqual(
      expect.arrayContaining(['Callout', 'img', 'video', 'audio', 'Accordion']),
    );
  });

  test('covers every compat descriptor', () => {
    expect([...PALETTE_DESCRIPTOR_NAMES]).toEqual(
      expect.arrayContaining(['GFMCallout', 'CommonMarkImage', 'HtmlDetailsAccordion']),
    );
  });

  test('covers non-portable-render descriptors (Math + MermaidFence)', () => {
    // Math + MermaidFence emit KaTeX HTML / SVG live-render output that
    // doesn't paste cleanly cross-app. Both walker primary path AND
    // Activity-hidden palette use the shared
    // `nonPortableRenderSourceFallback` helper to emit the same
    // `<pre class="mdx-component"><code>{markdown}</code></pre>` shape.
    expect([...PALETTE_DESCRIPTOR_NAMES]).toEqual(expect.arrayContaining(['Math', 'MermaidFence']));
  });

  test('exact size — adding a name requires intentional update of this list', () => {
    // Hard count anchor. If a descriptor is added or removed, this
    // failing test becomes the prompt to also update the palette switch
    // and PALETTE_DESCRIPTOR_NAMES together.
    expect(PALETTE_DESCRIPTOR_NAMES.length).toBe(10);
  });
});

describe('TYPE_TO_TONE — callout tone mapping', () => {
  test('covers the documented callout type set', () => {
    expect(Object.keys(TYPE_TO_TONE).sort()).toEqual(
      ['caution', 'important', 'note', 'tip', 'warning'].sort(),
    );
  });

  test('every tone defines color + bg without undefined values', () => {
    for (const [type, tone] of Object.entries(TYPE_TO_TONE)) {
      expect(tone.color, `tone[${type}].color`).toMatch(/^#[0-9a-f]{3,6}$/i);
      expect(tone.bg, `tone[${type}].bg`).toMatch(/^#[0-9a-f]{3,6}$/i);
    }
  });
});

describe('toneForType — type-to-tone lookup with prototype-pollution guard', () => {
  test('resolves known types to their tone', () => {
    expect(toneForType('note')).toBe(TYPE_TO_TONE.note);
    expect(toneForType('warning')).toBe(TYPE_TO_TONE.warning);
    expect(toneForType('caution')).toBe(TYPE_TO_TONE.caution);
  });

  test('falls back to "note" for unknown types', () => {
    expect(toneForType('unrecognized')).toBe(TYPE_TO_TONE.note);
    expect(toneForType('')).toBe(TYPE_TO_TONE.note);
  });

  test('Object.hasOwn guard blocks prototype-pollution names', () => {
    // Without the guard, `TYPE_TO_TONE['__proto__']` would walk the
    // prototype chain and return Object.prototype methods — the palette
    // would then emit `border-left: 3px solid undefined`, a DoS vector
    // a co-editing peer could trigger by setting `type="__proto__"`.
    // Mirrors the same guard at Callout.tsx + Accordion.tsx.
    for (const polluted of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const tone = toneForType(polluted);
      expect(tone, polluted).toBe(TYPE_TO_TONE.note);
      expect(tone.color).not.toBeUndefined();
      expect(tone.bg).not.toBeUndefined();
    }
  });
});

// ─── paletteUrlReason — portability decision (palette parity) ──────────
//
// Walker and palette consume the SAME classifier. `paletteUrlReason` is
// the palette-side surface — a thin `null|reason` wrapper over
// `classifyUrlPortability` that gives the palette tests a pure assertion
// target without needing a DOM (palette functions themselves create real
// `<img>`/`<video>`/`<audio>` elements, which bun-test cannot exercise).
// DOM-shape coverage of the actual swap happens in the cross-app
// sanitizer-proxy fixture tests and Playwright E2E.

describe('paletteUrlReason — portability decision', () => {
  test('returns null for fragment-only refs', () => {
    expect(paletteUrlReason('#section')).toBeNull();
    expect(paletteUrlReason('#')).toBeNull();
  });

  test('returns null for portable navigation schemes', () => {
    expect(paletteUrlReason('mailto:user@example.com')).toBeNull();
    expect(paletteUrlReason('tel:+15551234567')).toBeNull();
    expect(paletteUrlReason('sms:+15551234567')).toBeNull();
    expect(paletteUrlReason('ftp://example.com/file')).toBeNull();
    expect(paletteUrlReason('ftps://example.com/file')).toBeNull();
  });

  test('returns null for public http(s) hostnames', () => {
    expect(paletteUrlReason('https://example.com/x.jpg')).toBeNull();
    expect(paletteUrlReason('http://acme.io/photo.png')).toBeNull();
  });

  test('returns null for public unicast IP literals', () => {
    expect(paletteUrlReason('https://1.2.3.4/x.jpg')).toBeNull();
    expect(paletteUrlReason('https://[2001:4860:4860::8888]/x.jpg')).toBeNull();
  });

  test("returns 'relative' for bare relative paths", () => {
    expect(paletteUrlReason('./photo.jpg')).toBe('relative');
    expect(paletteUrlReason('photo.jpg')).toBe('relative');
    expect(paletteUrlReason('../assets/x.png')).toBe('relative');
  });

  test("returns 'server-absolute' for root-relative paths", () => {
    expect(paletteUrlReason('/foo/bar.jpg')).toBe('server-absolute');
    expect(paletteUrlReason('/api/v1/x.png')).toBe('server-absolute');
  });

  test("returns 'localhost' for literal localhost http(s) URLs", () => {
    expect(paletteUrlReason('http://localhost/x.jpg')).toBe('localhost');
    expect(paletteUrlReason('https://localhost:3000/photo.png')).toBe('localhost');
  });

  test("returns 'private-ip' for non-unicast IP literals (allowlist)", () => {
    // Spot-check across the IPv4 + IPv6 SpecialRanges enumeration. Full
    // per-range coverage lives in clipboard-sanitize.test.ts; this is a
    // palette-side smoke check confirming the reason wires through.
    expect(paletteUrlReason('http://10.0.0.1/x')).toBe('private-ip');
    expect(paletteUrlReason('http://192.168.1.1/x')).toBe('private-ip');
    expect(paletteUrlReason('http://127.0.0.1/x')).toBe('private-ip');
    expect(paletteUrlReason('http://169.254.1.1/x')).toBe('private-ip');
    expect(paletteUrlReason('http://[::1]/x')).toBe('private-ip');
    expect(paletteUrlReason('http://[fc00::1]/x')).toBe('private-ip');
  });

  test("returns 'other' for non-portable schemes", () => {
    expect(paletteUrlReason('data:image/png;base64,iVBORw0KGgo')).toBe('other');
    expect(paletteUrlReason('blob:https://example.com/abc')).toBe('other');
    expect(paletteUrlReason('file:///etc/passwd')).toBe('other');
  });

  test('throws on malformed URLs that survive the relative short-circuit', () => {
    // The walker call site wraps `paletteUrlReason` in try/catch and
    // emits `clipboard-walker-url-classifier-failed` on throw, falling
    // through to today's native-primitive emission.
    expect(() => paletteUrlReason('http://')).toThrow();
  });

  test('byte-identical drift fence vs classifyUrlPortability', () => {
    // If walker and palette ever diverge on the same URL, cross-app users
    // get inconsistent emissions depending on whether their copy hit the
    // live walker or the Activity-hidden palette. This test pins the
    // palette wrapper to the underlying classifier byte-identically — a
    // future refactor that introduces a custom palette-side rule fails
    // here before it ships.
    const cases = [
      './photo.jpg',
      '/api/v1/x.png',
      'http://localhost/x',
      'http://192.168.1.1/x',
      'data:image/png;base64,abc',
      'https://example.com/x.jpg',
      '#section',
      'mailto:user@example.com',
    ];
    for (const url of cases) {
      const expected = classifyUrlPortability(url);
      const actual = paletteUrlReason(url);
      if (expected.portable) {
        expect(actual, url).toBeNull();
      } else {
        expect(actual, url).toBe(expected.reason);
      }
    }
  });
});
