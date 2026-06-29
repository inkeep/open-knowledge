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
    const oversized = 'color: red; '.repeat(1000); // ~12KB
    expect(oversized.length).toBeGreaterThan(MAX_STYLE_SCAN_LEN);
    expect(sanitizeStyleAttrValue(oversized)).toBe('');
  });

  test('passes payloads at-or-just-below MAX_STYLE_SCAN_LEN through normally', () => {
    const justUnder = 'a'.repeat(MAX_STYLE_SCAN_LEN - 1);
    expect(justUnder.length).toBeLessThan(MAX_STYLE_SCAN_LEN);
    expect(sanitizeStyleAttrValue(justUnder)).toBe(justUnder);
  });

  test('MAX_STYLE_SCAN_LEN is a number compatible with the sibling sanitize-url.ts ceiling', () => {
    expect(MAX_STYLE_SCAN_LEN).toBe(10_000);
  });
});

describe('convertCssColors — modern CSS color (oklch/oklab/lab/lch) → rgb fallback', () => {
  function rgbTriple(value: string): [number, number, number] | null {
    const m = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }

  test('converts oklch to rgb on the happy path', () => {
    const out = convertCssColors('oklch(0.62 0.15 240)');
    expect(out).toMatch(/^rgb\(\d+,\s*\d+,\s*\d+\)$/);
    const triple = rgbTriple(out);
    expect(triple).not.toBeNull();
    if (triple) {
      const [r, g, b] = triple;
      expect(b).toBeGreaterThan(g);
      expect(g).toBeGreaterThan(r);
    }
  });

  test('pins endpoint oklch(0 0 0) → rgb(0, 0, 0) (sRGB transfer-function anchor at L=0)', () => {
    expect(convertCssColors('oklch(0 0 0)')).toBe('rgb(0, 0, 0)');
  });

  test('pins endpoint oklch(1 0 0) → rgb(255, 255, 255) (sRGB transfer-function anchor at L=1)', () => {
    expect(convertCssColors('oklch(1 0 0)')).toBe('rgb(255, 255, 255)');
  });

  test('pins in-gamut oklch(0.5 0.1 240) ≈ rgb(31, 106, 150) ± 3 (Ottosson-matrix coefficient anchor)', () => {
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
    expect(out.match(/rgb\(/g)?.length).toBe(2);
  });

  test('handles oklab / lab / lch sister functions', () => {
    expect(convertCssColors('oklab(0.5 0.1 0.05)')).toMatch(/^rgb\(/);
    expect(convertCssColors('lab(50 10 -20)')).toMatch(/^rgb\(/);
    expect(convertCssColors('lch(50 30 240)')).toMatch(/^rgb\(/);
  });

  test('handles CSS Color 4 `none` keyword (achromatic oklch produces a gray)', () => {
    const out = convertCssColors('oklch(0.5 none 0)');
    expect(out).toMatch(/^rgb\(/);
    const triple = rgbTriple(out);
    expect(triple).not.toBeNull();
    if (triple) {
      const [r, g, b] = triple;
      expect(Math.abs(r - g)).toBeLessThanOrEqual(1);
      expect(Math.abs(g - b)).toBeLessThanOrEqual(1);
    }
  });

  test('handles `none` for oklab a/b components and oklch hue', () => {
    expect(convertCssColors('oklab(0.5 none none)')).toMatch(/^rgb\(/);
    expect(convertCssColors('oklch(0.5 0.1 none)')).toMatch(/^rgb\(/);
  });

  test('handles negative a/b components in oklab (covers full sRGB color wheel)', () => {
    const out = convertCssColors('oklab(0.5 -0.1 0.05)');
    expect(out).toMatch(/^rgb\(/);
    const triple = rgbTriple(out);
    expect(triple).not.toBeNull();
    if (triple) {
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
    expect(convertCssColors('oklch(garbage)')).toBe('oklch(garbage)');
    expect(convertCssColors('1px solid oklch(only-two 240)')).toBe('1px solid oklch(only-two 240)');
  });

  test('passes payloads above MAX_COLOR_VALUE_LEN through unchanged (defense-in-depth ceiling)', () => {
    const oversized = `${'a'.repeat(MAX_COLOR_VALUE_LEN)} oklch(0.5 0.1 240)`;
    expect(oversized.length).toBeGreaterThan(MAX_COLOR_VALUE_LEN);
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
    expect(OPT_OUT_ATTR).toBe('data-clipboard-omit');
  });
});

describe('classifyUrlPortability — single-pass classification with reason bucket', () => {
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
      expect(classifyUrlPortability('http://LocalHost/x')).toEqual({
        portable: false,
        reason: 'localhost',
      });
    });

    test('trailing-dot localhost classifies as `localhost`', () => {
      expect(classifyUrlPortability('http://localhost./x')).toEqual({
        portable: false,
        reason: 'localhost',
      });
    });

    test('.localhost reserved-TLD subdomains (RFC 6761) classify as `localhost`', () => {
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
      expect(classifyUrlPortability('http://127.0.0.1/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('http://127.0.0.255/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('http://169.254.1.1/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('http://100.64.0.1/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('http://224.0.0.1/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('http://255.255.255.255/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('http://0.0.0.0/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('http://198.18.0.1/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('http://192.0.0.1/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('http://[::1]/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('http://[::]/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('http://[fc00::1]/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('http://[fe80::1]/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('http://[ff02::1]/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('https://[2001:db8::1]/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('https://[::ffff:192.0.2.1]/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('https://[2002::1]/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('https://[2001:0::]/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
      expect(classifyUrlPortability('https://[64:ff9b::1]/x')).toEqual({
        portable: false,
        reason: 'private-ip',
      });
    });

    test('non-portable schemes classify as `other`', () => {
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
      expect(classifyUrlPortability('vbscript:msgbox(1)')).toEqual({
        portable: false,
        reason: 'other',
      });
    });

    test('novel / future schemes classify as `other` (allowlist posture)', () => {
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
      expect(classifyUrlPortability('   #section')).toEqual({ portable: true });
    });

    test('classification is case-insensitive on scheme', () => {
      expect(classifyUrlPortability('MAILTO:user@example.com')).toEqual({ portable: true });
      expect(classifyUrlPortability('Tel:+15551234567')).toEqual({ portable: true });
      expect(classifyUrlPortability('HTTPS://EXAMPLE.COM/path')).toEqual({ portable: true });
    });

    test('non-default port hostnames pass', () => {
      expect(classifyUrlPortability('https://example.com:8443/path')).toEqual({ portable: true });
    });

    test('public IPv6 with port + path passes', () => {
      expect(classifyUrlPortability('https://[2001:4860:4860::8888]:8080/x.jpg')).toEqual({
        portable: true,
      });
    });
  });

  describe('malformed inputs throw (caller wraps in try/catch)', () => {
    test('throws on triple-colon garbage', () => {
      expect(() => classifyUrlPortability(':::')).toThrow();
    });

    test('throws on incomplete http://', () => {
      expect(() => classifyUrlPortability('http://')).toThrow();
    });

    test('throws on http: without authority', () => {
      expect(() => classifyUrlPortability('http:')).toThrow();
    });
  });
});
