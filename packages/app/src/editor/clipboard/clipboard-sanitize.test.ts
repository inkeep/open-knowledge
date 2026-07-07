/**
 * Co-located unit tests for the clipboard sanitization leaf module.
 *
 * Pure-helper boundary contract tests — no DOM required. The walker's
 * full DOM behavior (cloneNode parallel walk, view.nodeDOM lookup,
 * fallback palette firing on Activity-hidden subtrees) is exercised in
 * Playwright.
 */

import { describe, expect, test } from 'bun:test';
import {
  classifyUrlPortability,
  convertCssColors,
  isDangerousEventHandlerAttr,
  isSafeWalkerUrl,
  isSrcsetSafe,
  MAX_COLOR_VALUE_LEN,
  MAX_STYLE_SCAN_LEN,
  OPT_OUT_ATTR,
  sanitizeEmbeddedUrlValue,
  sanitizeStyleAttrValue,
  URL_BEARING_TEXT_ATTRS,
  URL_SCHEME_ATTRS,
} from './clipboard-sanitize.ts';

describe('URL_SCHEME_ATTRS — surface contract', () => {
  test('covers HTML-spec URL-bearing attribute set', () => {
    expect(URL_SCHEME_ATTRS.has('href')).toBe(true);
    expect(URL_SCHEME_ATTRS.has('src')).toBe(true);
    expect(URL_SCHEME_ATTRS.has('srcset')).toBe(true);
    expect(URL_SCHEME_ATTRS.has('poster')).toBe(true);
    expect(URL_SCHEME_ATTRS.has('formaction')).toBe(true);
    expect(URL_SCHEME_ATTRS.has('xlink:href')).toBe(true);
  });
});

describe('URL_BEARING_TEXT_ATTRS — surface contract', () => {
  test('covers OK canonical aria-label shape + sibling description fields', () => {
    expect(URL_BEARING_TEXT_ATTRS.has('aria-label')).toBe(true);
    expect(URL_BEARING_TEXT_ATTRS.has('aria-description')).toBe(true);
    expect(URL_BEARING_TEXT_ATTRS.has('title')).toBe(true);
  });
});

describe('isSafeWalkerUrl — allowlist URL classifier', () => {
  test('passes the standard navigation schemes', () => {
    expect(isSafeWalkerUrl('http://example.com')).toBe(true);
    expect(isSafeWalkerUrl('https://example.com')).toBe(true);
    expect(isSafeWalkerUrl('mailto:user@example.com')).toBe(true);
    expect(isSafeWalkerUrl('tel:+15555555555')).toBe(true);
    expect(isSafeWalkerUrl('ftp://example.com')).toBe(true);
    expect(isSafeWalkerUrl('sms:+15555555555')).toBe(true);
  });

  test('passes relative URL forms', () => {
    expect(isSafeWalkerUrl('/absolute/path.png')).toBe(true);
    expect(isSafeWalkerUrl('./sibling.png')).toBe(true);
    expect(isSafeWalkerUrl('../parent/path.png')).toBe(true);
    expect(isSafeWalkerUrl('#fragment')).toBe(true);
    expect(isSafeWalkerUrl('?query=1')).toBe(true);
  });

  test('passes bare filename and relative-path forms (isRelativeUrl fallback)', () => {
    // Walker operates on already-resolved live DOM where bare relative
    // paths CAN appear (e.g., `<img src="one.png">`). The `isRelativeUrl`
    // fallback in `isSafeWalkerUrl` is the test target — without it,
    // these forms would be dropped on copy.
    expect(isSafeWalkerUrl('photo.png')).toBe(true);
    expect(isSafeWalkerUrl('path/to/image.jpg')).toBe(true);
    expect(isSafeWalkerUrl('subdir/file.svg')).toBe(true);
  });

  test('passes empty / whitespace-only URL (benign no-op href)', () => {
    expect(isSafeWalkerUrl('')).toBe(true);
    expect(isSafeWalkerUrl('   ')).toBe(true);
  });

  test('blocks the dangerous schemes by name', () => {
    expect(isSafeWalkerUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeWalkerUrl('vbscript:msgbox')).toBe(false);
    expect(isSafeWalkerUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeWalkerUrl('chrome-extension://aabb/script.js')).toBe(false);
    expect(isSafeWalkerUrl('moz-extension://aabb/script.js')).toBe(false);
  });

  test('blocks data: schemes including raster image MIME types', () => {
    // Allowlist excludes all data: schemes — descriptor img/video/audio src
    // already passes through `sanitizeComponentProps` upstream, which uses
    // the same allowlist. Walker stays consistent with the upstream gate.
    expect(isSafeWalkerUrl('data:image/png;base64,iVBOR')).toBe(false);
    expect(isSafeWalkerUrl('data:image/svg+xml,<svg onload=alert(1)>')).toBe(false);
    expect(isSafeWalkerUrl('data:text/html,<script>')).toBe(false);
  });

  test('blocks novel / future schemes by default (allowlist posture)', () => {
    expect(isSafeWalkerUrl('intent://launch')).toBe(false);
    expect(isSafeWalkerUrl('blob:https://example.com/uuid')).toBe(false);
    expect(isSafeWalkerUrl('view-source:https://example.com')).toBe(false);
    expect(isSafeWalkerUrl('zoommtg://example')).toBe(false);
  });

  test('blocks leading-whitespace bypass per WHATWG URL preprocessing', () => {
    // Browsers strip leading ASCII whitespace before parsing href; a regex
    // that anchors on `^javascript:` without trimming is bypassable.
    expect(isSafeWalkerUrl(' javascript:alert(1)')).toBe(false);
    expect(isSafeWalkerUrl('\tjavascript:alert(1)')).toBe(false);
    expect(isSafeWalkerUrl('\n  javascript:alert(1)')).toBe(false);
  });

  test('classification is case-insensitive on scheme', () => {
    expect(isSafeWalkerUrl('JAVASCRIPT:alert(1)')).toBe(false);
    expect(isSafeWalkerUrl('JavaScript:alert(1)')).toBe(false);
    expect(isSafeWalkerUrl('HTTPS://example.com')).toBe(true);
  });
});

describe('isSrcsetSafe — comma-separated multi-URL classifier', () => {
  test('passes when every candidate URL is safe', () => {
    expect(isSrcsetSafe('one.png 1x, two.png 2x')).toBe(true);
    expect(isSrcsetSafe('https://a.example/img 480w, https://b.example/img 960w')).toBe(true);
  });

  test('fails when ANY candidate URL is dangerous (HTML srcset spec)', () => {
    // Per WHATWG HTML §4.8.4.3 srcset is a comma-separated list of image
    // candidate strings; a head-anchored `^javascript:` regex on the whole
    // attribute value misses dangerous URLs after the first comma.
    expect(isSrcsetSafe('safe.jpg 1x, javascript:alert(1) 2x')).toBe(false);
    expect(isSrcsetSafe('javascript:alert(1) 1x, safe.jpg 2x')).toBe(false);
  });

  test('passes single-URL srcset (no commas)', () => {
    expect(isSrcsetSafe('safe.jpg')).toBe(true);
    expect(isSrcsetSafe('safe.jpg 2x')).toBe(true);
  });

  test('handles trailing whitespace and empty candidates gracefully', () => {
    expect(isSrcsetSafe('safe.jpg 1x,  ,safe2.jpg 2x')).toBe(true);
    expect(isSrcsetSafe('  ')).toBe(true);
  });
});

describe('sanitizeEmbeddedUrlValue — text-attr URL substitution', () => {
  test('replaces dangerous-scheme URLs with [blocked] inside a label', () => {
    expect(sanitizeEmbeddedUrlValue('Link: javascript:alert(1)')).toBe('Link: [blocked]');
    expect(sanitizeEmbeddedUrlValue('See vbscript:msgbox for details')).toBe(
      'See [blocked] for details',
    );
  });

  test('preserves wrapping label text around the substitution', () => {
    // Canonical OK shape: internal-link.ts emits aria-label="Link: <href>".
    // Substitution must not drop the "Link: " prefix.
    const out = sanitizeEmbeddedUrlValue('Link: javascript:alert(1)');
    expect(out).toContain('Link:');
    expect(out).toContain('[blocked]');
  });

  test('passes safe URLs through unchanged', () => {
    expect(sanitizeEmbeddedUrlValue('Link: https://example.com')).toBe('Link: https://example.com');
    expect(sanitizeEmbeddedUrlValue('Link: /relative/path')).toBe('Link: /relative/path');
    expect(sanitizeEmbeddedUrlValue('Link: mailto:foo@example.com')).toBe(
      'Link: mailto:foo@example.com',
    );
  });

  test('passes plain prose without URLs unchanged', () => {
    expect(sanitizeEmbeddedUrlValue('Link')).toBe('Link');
    expect(sanitizeEmbeddedUrlValue('Some descriptive text')).toBe('Some descriptive text');
  });

  test('passes no-space-after-colon labels through unchanged (label-fidelity)', () => {
    // Earlier revision matched RFC 3986 scheme grammar broadly, so labels
    // like "Item:value" got rewritten to "[blocked]" because their shape
    // looked URL-like. The tightened matcher requires `://` (authority)
    // OR a known dangerous scheme prefix — these label shapes survive
    // intact. Aria-labels are read by assistive tech as text, not as
    // URLs, so leaving novel-scheme tokens unblocked here trades label
    // fidelity for a small surface that does not navigate.
    expect(sanitizeEmbeddedUrlValue('Item:value')).toBe('Item:value');
    expect(sanitizeEmbeddedUrlValue('Status:active')).toBe('Status:active');
    expect(sanitizeEmbeddedUrlValue('Tag:urgent')).toBe('Tag:urgent');
    expect(sanitizeEmbeddedUrlValue('Type:warning Severity:high')).toBe(
      'Type:warning Severity:high',
    );
  });

  test('returns null when nothing changed (caller can avoid setAttribute call)', () => {
    expect(sanitizeEmbeddedUrlValue('Link', { reportNoChange: true })).toBeNull();
    expect(
      sanitizeEmbeddedUrlValue('Link: https://example.com', { reportNoChange: true }),
    ).toBeNull();
    expect(sanitizeEmbeddedUrlValue('Item:value', { reportNoChange: true })).toBeNull();
  });

  test('blocks each named dangerous scheme in embedded context', () => {
    // URL_LIKE_TOKEN_RE alternation lists 6 dangerous schemes:
    // javascript / vbscript / data / file / chrome-extension / moz-extension.
    // A typo in the alternation would silently leak one scheme through —
    // this loop pins each scheme as exercised in label content.
    const schemes: Array<[string, string]> = [
      ['javascript:alert(1)', 'javascript:alert(1)'],
      ['vbscript:msgbox(1)', 'vbscript:msgbox(1)'],
      ['data:text/html,<script>', 'data:text/html,<script>'],
      ['file:///etc/passwd', 'file:///etc/passwd'],
      ['chrome-extension://aabb/script.js', 'chrome-extension://aabb/script.js'],
      ['moz-extension://aabb/script.js', 'moz-extension://aabb/script.js'],
    ];
    for (const [scheme] of schemes) {
      const out = sanitizeEmbeddedUrlValue(`Link: ${scheme}`);
      expect(out, scheme).not.toContain(scheme);
      expect(out, scheme).toContain('[blocked]');
    }
  });

  test('blocks multiple URLs in a single attribute value', () => {
    const input = 'See javascript:alert(1) and data:text/html,<script>';
    const out = sanitizeEmbeddedUrlValue(input);
    expect(out).not.toContain('javascript:alert');
    expect(out).not.toContain('data:text/html');
    expect(out).toContain('See ');
    expect(out).toContain('and ');
    // Both URLs replaced — count [blocked] occurrences.
    expect(out?.match(/\[blocked\]/g)?.length).toBe(2);
  });
});

describe('isDangerousEventHandlerAttr — on* event handler classifier', () => {
  test('matches DOM event handler attributes', () => {
    expect(isDangerousEventHandlerAttr('onclick')).toBe(true);
    expect(isDangerousEventHandlerAttr('onerror')).toBe(true);
    expect(isDangerousEventHandlerAttr('onload')).toBe(true);
    expect(isDangerousEventHandlerAttr('onmouseover')).toBe(true);
    expect(isDangerousEventHandlerAttr('onfocus')).toBe(true);
  });

  test('matches case-insensitively', () => {
    expect(isDangerousEventHandlerAttr('OnClick')).toBe(true);
    expect(isDangerousEventHandlerAttr('ONERROR')).toBe(true);
  });

  test('does NOT match non-event attributes that happen to start with on', () => {
    // `one`, `only`, `once` etc. are not event handlers — require length
    // discriminator (event handlers like `onfoo` are at least 3 chars).
    expect(isDangerousEventHandlerAttr('on')).toBe(false);
  });

  test('does NOT match safe attributes', () => {
    expect(isDangerousEventHandlerAttr('class')).toBe(false);
    expect(isDangerousEventHandlerAttr('style')).toBe(false);
    expect(isDangerousEventHandlerAttr('href')).toBe(false);
    expect(isDangerousEventHandlerAttr('aria-label')).toBe(false);
  });
});

describe('sanitizeStyleAttrValue — inline-style url() / expression() filter', () => {
  test('drops styles containing url(javascript:...) payloads', () => {
    // Browsers resolve `url(javascript:...)` against `background-image`,
    // `content`, `list-style-image`, `cursor`, etc. — defense-in-depth at
    // the walker boundary mirrors `sanitizeStyleString` in sanitize-url.ts.
    expect(sanitizeStyleAttrValue('background: url(javascript:alert(1))')).toBe('');
    expect(sanitizeStyleAttrValue("background: url('javascript:alert(1)')")).toBe('');
    expect(sanitizeStyleAttrValue('color: red; background-image: url(vbscript:msgbox)')).toBe('');
  });

  test('drops styles containing expression() payloads (legacy IE gadget)', () => {
    expect(sanitizeStyleAttrValue('width: expression(alert(1))')).toBe('');
  });

  test('drops styles containing url(data:...) (covers data:text/html SVG payloads)', () => {
    expect(sanitizeStyleAttrValue('content: url(data:text/html,<script>)')).toBe('');
  });

  test('passes safe inline styles through unchanged', () => {
    expect(sanitizeStyleAttrValue('color: red; padding: 4px')).toBe('color: red; padding: 4px');
    expect(sanitizeStyleAttrValue('background-color: rgb(255, 0, 0)')).toBe(
      'background-color: rgb(255, 0, 0)',
    );
  });

  test('passes safe url() references through unchanged', () => {
    expect(sanitizeStyleAttrValue('background-image: url(https://example.com/img.png)')).toBe(
      'background-image: url(https://example.com/img.png)',
    );
  });

  test('drops mega-payloads above MAX_STYLE_SCAN_LEN without a regex scan', () => {
    // Defense-in-depth ceiling on regex-scan cost. A 12KB payload is two
    // orders of magnitude above any legitimate inline style; values above
    // the threshold are dropped entirely (no scan, no opportunity for
    // ReDoS amplification on adversarial inputs).
    const oversized = 'color: red; '.repeat(1000); // ~12KB
    expect(oversized.length).toBeGreaterThan(MAX_STYLE_SCAN_LEN);
    expect(sanitizeStyleAttrValue(oversized)).toBe('');
  });

  test('passes payloads at-or-just-below MAX_STYLE_SCAN_LEN through normally', () => {
    // Boundary case — exactly MAX_STYLE_SCAN_LEN - 1 chars. Should still
    // scan the value (and pass through, since no dangerous pattern).
    const justUnder = 'a'.repeat(MAX_STYLE_SCAN_LEN - 1);
    expect(justUnder.length).toBeLessThan(MAX_STYLE_SCAN_LEN);
    expect(sanitizeStyleAttrValue(justUnder)).toBe(justUnder);
  });

  test('MAX_STYLE_SCAN_LEN is a number compatible with the sibling sanitize-url.ts ceiling', () => {
    // Anchor — both walker and sanitize-url use the same 10_000 ceiling.
    // A regression that changes one without the other surfaces here.
    expect(MAX_STYLE_SCAN_LEN).toBe(10_000);
  });
});

describe('convertCssColors — modern CSS color (oklch/oklab/lab/lch) → rgb fallback', () => {
  // Helper: extract first rgb-channel triple from "rgb(R, G, B)".
  function rgbTriple(value: string): [number, number, number] | null {
    const m = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }

  test('converts oklch to rgb on the happy path', () => {
    // `oklch(0.62 0.15 240)` is a mid-saturation blue; sanity-check the
    // triple is in the blue family — exact integer values depend on
    // floating-point precision so we range-bound rather than equality-pin.
    const out = convertCssColors('oklch(0.62 0.15 240)');
    expect(out).toMatch(/^rgb\(\d+,\s*\d+,\s*\d+\)$/);
    const triple = rgbTriple(out);
    expect(triple).not.toBeNull();
    if (triple) {
      const [r, g, b] = triple;
      // Blue dominates green dominates red for this hue.
      expect(b).toBeGreaterThan(g);
      expect(g).toBeGreaterThan(r);
    }
  });

  test('pins endpoint oklch(0 0 0) → rgb(0, 0, 0) (sRGB transfer-function anchor at L=0)', () => {
    // Mechanical pin against any future change to `linearToSrgbChannel`'s
    // small-value branch (the linear `12.92x` segment for x ≤ 0.0031308).
    expect(convertCssColors('oklch(0 0 0)')).toBe('rgb(0, 0, 0)');
  });

  test('pins endpoint oklch(1 0 0) → rgb(255, 255, 255) (sRGB transfer-function anchor at L=1)', () => {
    // Anchors the gamma branch (`1.055·x^(1/2.4) − 0.055`) and the byte
    // clamp at the upper extreme. A coefficient drift that pushes the
    // result to 254 / 256 surfaces here.
    expect(convertCssColors('oklch(1 0 0)')).toBe('rgb(255, 255, 255)');
  });

  test('pins in-gamut oklch(0.5 0.1 240) ≈ rgb(31, 106, 150) ± 3 (Ottosson-matrix coefficient anchor)', () => {
    // Pinned reference triple for `oklch(0.5 0.1 240)` — chosen because it
    // is *in-gamut* (no channel hits 0 or 255), so a coefficient regression
    // in `oklabToLinearSrgb` (sign error, dropped term, transposed entry)
    // changes the triple in a way clip-clamping cannot mask. Tolerance ±3
    // per channel accommodates floating-point path differences across
    // engine versions; no gamut
    // mapping is in play here.
    //
    // Reference values were computed by *this implementation* against the
    // Ottosson matrix. They diverge from Chrome's
    // `getComputedStyle()` triple for the same input — Chrome implements
    // CSS Color Module Level 4 gamut-mapping (binary-search chroma
    // reduction in oklch), whereas this walker does naive clip-after-
    // conversion since it is converting at *copy time* for cross-app
    // fidelity, not for in-app rendering. The naive clip is documented in
    // `clipboard-sanitize.ts` (`toByte`).
    const out = convertCssColors('oklch(0.5 0.1 240)');
    const triple = rgbTriple(out);
    expect(triple).not.toBeNull();
    if (triple) {
      const [r, g, b] = triple;
      expect(r).toBeGreaterThanOrEqual(28);
      expect(r).toBeLessThanOrEqual(34);
      expect(g).toBeGreaterThanOrEqual(103);
      expect(g).toBeLessThanOrEqual(109);
      expect(b).toBeGreaterThanOrEqual(147);
      expect(b).toBeLessThanOrEqual(153);
    }
  });

  test('preserves alpha as rgba()', () => {
    const out = convertCssColors('oklch(0.5 0.1 240 / 0.5)');
    expect(out).toMatch(/^rgba\(\d+,\s*\d+,\s*\d+,\s*0\.5\)$/);
  });

  test('preserves the surrounding compound value (suffix + prefix)', () => {
    const out = convertCssColors('1px solid oklch(0.62 0.15 240)');
    expect(out).toMatch(/^1px solid rgb\(\d+,\s*\d+,\s*\d+\)$/);
  });

  test('converts every modern color in a multi-color value (gradients)', () => {
    const out = convertCssColors('linear-gradient(oklch(0.5 0.1 0), oklch(0.5 0.1 240))');
    expect(out).not.toContain('oklch(');
    // Two rgb() values inside the gradient.
    expect(out.match(/rgb\(/g)?.length).toBe(2);
  });

  test('handles oklab / lab / lch sister functions', () => {
    expect(convertCssColors('oklab(0.5 0.1 0.05)')).toMatch(/^rgb\(/);
    expect(convertCssColors('lab(50 10 -20)')).toMatch(/^rgb\(/);
    expect(convertCssColors('lch(50 30 240)')).toMatch(/^rgb\(/);
  });

  test('handles CSS Color 4 `none` keyword (achromatic oklch produces a gray)', () => {
    // Tailwind's neutral palette uses `oklch(L none H)` for fully
    // achromatic (zero-chroma) values. `parseColorComponent` maps `none`
    // to 0 per CSS Color 4 spec, so the math collapses to L-only and the
    // result must be a gray (r ≈ g ≈ b).
    const out = convertCssColors('oklch(0.5 none 0)');
    expect(out).toMatch(/^rgb\(/);
    const triple = rgbTriple(out);
    expect(triple).not.toBeNull();
    if (triple) {
      const [r, g, b] = triple;
      // Achromatic — all three channels equal within rounding tolerance.
      expect(Math.abs(r - g)).toBeLessThanOrEqual(1);
      expect(Math.abs(g - b)).toBeLessThanOrEqual(1);
    }
  });

  test('handles `none` for oklab a/b components and oklch hue', () => {
    // All four positions accept `none`. None-only oklab is structurally
    // equivalent to (L, 0, 0) and produces a gray.
    expect(convertCssColors('oklab(0.5 none none)')).toMatch(/^rgb\(/);
    expect(convertCssColors('oklch(0.5 0.1 none)')).toMatch(/^rgb\(/);
  });

  test('handles negative a/b components in oklab (covers full sRGB color wheel)', () => {
    // The Ottosson matrix is a real-valued linear transform — negative
    // `a` (greener) and negative `b` (bluer) are valid oklab inputs that
    // appear in Chrome's `getComputedStyle()` output for any color in the
    // green / blue / cyan / purple quadrants. A regression that mishandles
    // sign on these terms would silently break half the color wheel.
    const out = convertCssColors('oklab(0.5 -0.1 0.05)');
    expect(out).toMatch(/^rgb\(/);
    const triple = rgbTriple(out);
    expect(triple).not.toBeNull();
    if (triple) {
      // Negative `a` is greener than red; the green channel should
      // dominate the red channel.
      const [r, g] = triple;
      expect(g).toBeGreaterThan(r);
    }
  });

  test('passes legacy color forms through unchanged (no-op invariants)', () => {
    expect(convertCssColors('rgb(255, 0, 0)')).toBe('rgb(255, 0, 0)');
    expect(convertCssColors('rgba(255, 0, 0, 0.5)')).toBe('rgba(255, 0, 0, 0.5)');
    expect(convertCssColors('#ff0000')).toBe('#ff0000');
    expect(convertCssColors('hsl(0, 100%, 50%)')).toBe('hsl(0, 100%, 50%)');
    expect(convertCssColors('red')).toBe('red');
    expect(convertCssColors('transparent')).toBe('transparent');
    expect(convertCssColors('currentColor')).toBe('currentColor');
    expect(convertCssColors('inherit')).toBe('inherit');
    expect(convertCssColors('initial')).toBe('initial');
    expect(convertCssColors('')).toBe('');
  });

  test('clamps out-of-gamut colors to [0, 255] without NaN', () => {
    // High-chroma red far outside sRGB.
    const out = convertCssColors('oklch(0.9 0.4 30)');
    const triple = rgbTriple(out);
    expect(triple).not.toBeNull();
    if (triple) {
      for (const channel of triple) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(255);
        expect(Number.isFinite(channel)).toBe(true);
      }
    }
  });

  test('returns input unchanged on malformed function bodies (no throw)', () => {
    // Garbage body — replacement leaves the original token in place.
    expect(convertCssColors('oklch(garbage)')).toBe('oklch(garbage)');
    expect(convertCssColors('1px solid oklch(only-two 240)')).toBe('1px solid oklch(only-two 240)');
  });

  test('passes payloads above MAX_COLOR_VALUE_LEN through unchanged (defense-in-depth ceiling)', () => {
    const oversized = `${'a'.repeat(MAX_COLOR_VALUE_LEN)} oklch(0.5 0.1 240)`;
    expect(oversized.length).toBeGreaterThan(MAX_COLOR_VALUE_LEN);
    // No conversion happens — the entire value passes through (not blocked,
    // unlike `sanitizeStyleAttrValue` which drops oversized payloads).
    expect(convertCssColors(oversized)).toBe(oversized);
  });

  test('matches case-insensitively', () => {
    expect(convertCssColors('OKLCH(0.62 0.15 240)')).toMatch(/^rgb\(/);
    expect(convertCssColors('OkLcH(0.62 0.15 240)')).toMatch(/^rgb\(/);
  });

  test('MAX_COLOR_VALUE_LEN matches the sibling MAX_STYLE_SCAN_LEN ceiling', () => {
    expect(MAX_COLOR_VALUE_LEN).toBe(10_000);
    expect(MAX_COLOR_VALUE_LEN).toBe(MAX_STYLE_SCAN_LEN);
  });
});

describe('OPT_OUT_ATTR — descriptor opt-out marker', () => {
  test('value is exactly `data-clipboard-omit`', () => {
    // Anchor — the literal value is the attribute name descriptors must
    // set on chrome elements that should not reach clipboard. A typo
    // (e.g., `data-clipboard-ommit`) would silently fail to opt out, so
    // descriptors MUST import this constant rather than hardcode the
    // string. Pin the literal here so a refactor that renames the
    // attribute fails the consumer-side checks loudly.
    expect(OPT_OUT_ATTR).toBe('data-clipboard-omit');
  });
});

describe('classifyUrlPortability — single-pass classification with reason bucket', () => {
  // Single source of truth — every production call site (walker
  // `classifyUrlAttr`, palette `paletteUrlReason`, walker `classifyLeaf
  // Element`) consumes the `reason` axis directly for the
  // `clipboard-walker-url-source-emitted` telemetry dimension. These
  // tests pin the reason bucket per non-portable category so a future
  // change that flips a URL's bucket fails loudly (the bucket is a
  // telemetry dimension — dashboards segment by these literals).

  describe('portable inputs (reason absent)', () => {
    test('fragment-only refs return { portable: true }', () => {
      expect(classifyUrlPortability('#section')).toEqual({ portable: true });
      expect(classifyUrlPortability('#')).toEqual({ portable: true });
    });

    test('http(s) public hostnames return { portable: true }', () => {
      expect(classifyUrlPortability('https://example.com/x')).toEqual({ portable: true });
      expect(classifyUrlPortability('http://example.com')).toEqual({ portable: true });
    });

    test('mailto / tel / sms / ftp schemes return { portable: true }', () => {
      expect(classifyUrlPortability('mailto:user@example.com')).toEqual({ portable: true });
      expect(classifyUrlPortability('tel:+15551234567')).toEqual({ portable: true });
      expect(classifyUrlPortability('sms:+15551234567')).toEqual({ portable: true });
      expect(classifyUrlPortability('ftp://example.com/x')).toEqual({ portable: true });
      expect(classifyUrlPortability('ftps://example.com/x')).toEqual({ portable: true });
    });

    test('public IP literals return { portable: true }', () => {
      // Google DNS — verified unicast against ipaddr.js@2.4.0.
      expect(classifyUrlPortability('http://1.2.3.4/x')).toEqual({ portable: true });
      expect(classifyUrlPortability('http://[2001:4860:4860::8888]/x')).toEqual({
        portable: true,
      });
    });
  });

  describe('non-portable inputs (reason buckets)', () => {
    test('bare relative paths classify as `relative`', () => {
      expect(classifyUrlPortability('./photo.jpg')).toEqual({
        portable: false,
        reason: 'relative',
      });
      expect(classifyUrlPortability('photo.png')).toEqual({
        portable: false,
        reason: 'relative',
      });
      expect(classifyUrlPortability('../foo/bar.md')).toEqual({
        portable: false,
        reason: 'relative',
      });
    });

    test('root-relative paths classify as `server-absolute`', () => {
      expect(classifyUrlPortability('/foo/bar')).toEqual({
        portable: false,
        reason: 'server-absolute',
      });
      expect(classifyUrlPortability('/api/v1/asset.jpg')).toEqual({
        portable: false,
        reason: 'server-absolute',
      });
      expect(classifyUrlPortability('/')).toEqual({
        portable: false,
        reason: 'server-absolute',
      });
    });

    test('protocol-relative URLs (`//host/path`) classify as `server-absolute`', () => {
      // Protocol-relative URLs depend on the source page's scheme to resolve;
      // they're non-portable by construction. `isRelativeUrl` short-circuits
      // (no colon → relative); the classifier then takes the leading `/` and
      // buckets as server-absolute. Pinning the current behavior so a future
      // change to either function (e.g. adding protocol-relative detection
      // upstream) doesn't silently flip a real-world clipboard input class.
      expect(classifyUrlPortability('//example.com/img.jpg')).toEqual({
        portable: false,
        reason: 'server-absolute',
      });
      expect(classifyUrlPortability('//cdn.example.com/assets/logo.svg')).toEqual({
        portable: false,
        reason: 'server-absolute',
      });
    });

    test('localhost classifies as `localhost`', () => {
      expect(classifyUrlPortability('http://localhost/x')).toEqual({
        portable: false,
        reason: 'localhost',
      });
      expect(classifyUrlPortability('https://localhost:3000/api')).toEqual({
        portable: false,
        reason: 'localhost',
      });
      // Case-insensitivity — WHATWG URL parser lowercases hostnames.
      expect(classifyUrlPortability('http://LocalHost/x')).toEqual({
        portable: false,
        reason: 'localhost',
      });
    });

    test('trailing-dot localhost classifies as `localhost`', () => {
      // URL parsing preserves the trailing dot, which would slip past an
      // exact-equality check.
      expect(classifyUrlPortability('http://localhost./x')).toEqual({
        portable: false,
        reason: 'localhost',
      });
    });

    test('.localhost reserved-TLD subdomains (RFC 6761) classify as `localhost`', () => {
      // Per RFC 6761 §6.3 the entire `.localhost` TLD is reserved for
      // loopback. `foo.localhost` and `bar.localhost.` must classify
      // as non-portable under the `localhost` bucket.
      expect(classifyUrlPortability('http://foo.localhost/x')).toEqual({
        portable: false,
        reason: 'localhost',
      });
      expect(classifyUrlPortability('http://foo.bar.localhost/x')).toEqual({
        portable: false,
        reason: 'localhost',
      });
      expect(classifyUrlPortability('http://foo.localhost./x')).toEqual({
        portable: false,
        reason: 'localhost',
      });
    });

    test('private/loopback IPs classify as `private-ip`', () => {
      // Reference values verified against ipaddr.js@2.4.0's `range()` API.
      // These pins guard against three regression classes: (1) ipaddr's
      // range table changing in a semver-major bump; (2) a refactor that
      // flips the allowlist to a blocklist (re-introducing the implementer-
      // judgment gap an enumerated blocklist suffers); (3) a typo that
      // misroutes IPv4 vs IPv6 isValid.
      // RFC 1918 private.
      expect(classifyUrlPortability('http://10.0.0.1/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('http://172.16.0.1/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('http://192.168.1.1/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      // Loopback (127.0.0.0/8).
      expect(classifyUrlPortability('http://127.0.0.1/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('http://127.0.0.255/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      // Link-local (169.254.0.0/16).
      expect(classifyUrlPortability('http://169.254.1.1/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      // Carrier-grade NAT (RFC 6598, 100.64.0.0/10).
      expect(classifyUrlPortability('http://100.64.0.1/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      // Multicast (224.0.0.0/4).
      expect(classifyUrlPortability('http://224.0.0.1/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      // Broadcast.
      expect(classifyUrlPortability('http://255.255.255.255/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      // Unspecified.
      expect(classifyUrlPortability('http://0.0.0.0/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      // Reserved (e.g., 198.18.0.0/15 benchmarking).
      expect(classifyUrlPortability('http://198.18.0.1/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('http://192.0.0.1/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      // IPv6 loopback.
      expect(classifyUrlPortability('http://[::1]/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      // IPv6 unspecified.
      expect(classifyUrlPortability('http://[::]/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      // IPv6 ULA (fc00::/7).
      expect(classifyUrlPortability('http://[fc00::1]/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      // IPv6 link-local (fe80::/10).
      expect(classifyUrlPortability('http://[fe80::1]/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      // IPv6 multicast (ff00::/8).
      expect(classifyUrlPortability('http://[ff02::1]/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      // IPv6 documentation prefix 2001:db8::/32 (range = `reserved`).
      // RFC 3849 reserves this prefix for documentation examples — ipaddr
      // classifies as `reserved`, which our allowlist treats as
      // non-portable. Authors who use a documentation address by accident
      // get a source-fallback emission, which is the correct degradation.
      expect(classifyUrlPortability('https://[2001:db8::1]/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      // IPv4-mapped IPv6 (::ffff:.../96, range = `ipv4Mapped`) — tunneling
      // format used by dual-stack hosts; not portable cross-machine.
      expect(classifyUrlPortability('https://[::ffff:192.0.2.1]/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      // IPv6 6to4 (2002::/16).
      expect(classifyUrlPortability('https://[2002::1]/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      // IPv6 teredo (2001::/32).
      expect(classifyUrlPortability('https://[2001:0::]/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      // IPv6 RFC 6052 NAT64 (64:ff9b::/96).
      expect(classifyUrlPortability('https://[64:ff9b::1]/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
    });

    test('non-portable schemes classify as `other`', () => {
      // Schemes outside the portable navigation set + http(s) collapse
      // into `other`.
      expect(classifyUrlPortability('blob:https://example.com/abc')).toEqual({
        portable: false,
        reason: 'other',
      });
      expect(classifyUrlPortability('file:///etc/hosts')).toEqual({
        portable: false,
        reason: 'other',
      });
      expect(classifyUrlPortability('data:text/plain;base64,SGVsbG8=')).toEqual({
        portable: false,
        reason: 'other',
      });
      expect(classifyUrlPortability('chrome-extension://abc/x')).toEqual({
        portable: false,
        reason: 'other',
      });
      expect(classifyUrlPortability('moz-extension://aabb/script.js')).toEqual({
        portable: false,
        reason: 'other',
      });
      expect(classifyUrlPortability('javascript:alert(1)')).toEqual({
        portable: false,
        reason: 'other',
      });
      // `new URL('vbscript:msgbox(1)')` succeeds in WHATWG-compliant
      // parsers (vbscript is a non-special scheme). Classifier rejects on
      // scheme check, not on parse failure.
      expect(classifyUrlPortability('vbscript:msgbox(1)')).toEqual({
        portable: false,
        reason: 'other',
      });
    });

    test('novel / future schemes classify as `other` (allowlist posture)', () => {
      // Schemes not on the portable list AND not http(s) classify
      // non-portable. Mirrors the safety-allowlist posture in
      // `isSafeWalkerUrl` (novel schemes fail closed).
      expect(classifyUrlPortability('intent://launch/example')).toEqual({
        portable: false,
        reason: 'other',
      });
      expect(classifyUrlPortability('zoommtg://example/123')).toEqual({
        portable: false,
        reason: 'other',
      });
      expect(classifyUrlPortability('view-source:https://example.com')).toEqual({
        portable: false,
        reason: 'other',
      });
    });

    test('empty + whitespace-only inputs classify as `relative`', () => {
      // Empty and post-trim-empty inputs lack a scheme and reach the
      // relative-URL short-circuit before the URL constructor.
      expect(classifyUrlPortability('')).toEqual({
        portable: false,
        reason: 'relative',
      });
      expect(classifyUrlPortability('   ')).toEqual({
        portable: false,
        reason: 'relative',
      });
    });

    test('query-only refs classify as `relative`', () => {
      expect(classifyUrlPortability('?q=1')).toEqual({
        portable: false,
        reason: 'relative',
      });
    });
  });

  describe('portable shape edge cases', () => {
    test('leading-whitespace fragment passes (URL preprocessing trims)', () => {
      // Browsers strip leading ASCII whitespace before parsing. Match the
      // sister `isSafeWalkerUrl` policy: trim before classification so
      // `   #section` is recognized as a fragment ref.
      expect(classifyUrlPortability('   #section')).toEqual({ portable: true });
    });

    test('classification is case-insensitive on scheme', () => {
      expect(classifyUrlPortability('MAILTO:user@example.com')).toEqual({ portable: true });
      expect(classifyUrlPortability('Tel:+15551234567')).toEqual({ portable: true });
      expect(classifyUrlPortability('HTTPS://EXAMPLE.COM/path')).toEqual({ portable: true });
    });

    test('non-default port hostnames pass', () => {
      // `URL.hostname` strips the port so the host check sees `example.com`
      // not `example.com:8443`.
      expect(classifyUrlPortability('https://example.com:8443/path')).toEqual({ portable: true });
    });

    test('public IPv6 with port + path passes', () => {
      expect(classifyUrlPortability('https://[2001:4860:4860::8888]:8080/x.jpg')).toEqual({
        portable: true,
      });
    });
  });

  describe('malformed inputs throw (caller wraps in try/catch)', () => {
    // These inputs survive `isRelativeUrl` (they have a colon before any
    // path separator, so look "scheme-like") but cannot be parsed by
    // `new URL()`. The walker call site catches the throw, emits
    // `clipboard-walker-url-classifier-failed` telemetry, and preserves
    // the URL-bearing element unchanged. The throw is the contract.
    test('throws on triple-colon garbage', () => {
      expect(() => classifyUrlPortability(':::')).toThrow();
    });

    test('throws on incomplete http://', () => {
      expect(() => classifyUrlPortability('http://')).toThrow();
    });

    test('throws on http: without authority', () => {
      // `http:` without `//` and without a path is not a valid URL.
      expect(() => classifyUrlPortability('http:')).toThrow();
    });
  });
});
