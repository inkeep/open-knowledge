import type { Node as PmNode } from '@tiptap/pm/model';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { classifyUrlPortability } from './clipboard-sanitize.ts';
import {
  PALETTE_DESCRIPTOR_NAMES,
  paletteFor,
  paletteUrlReason,
  TYPE_TO_TONE,
  toneForType,
} from './clipboard-walker-fallback-palette.ts';
import { nonPortableDescriptorNames } from './non-portable-descriptors.test-helper.ts';

describe('PALETTE_DESCRIPTOR_NAMES — registry coverage', () => {
  test('covers every canonical descriptor', () => {
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
    expect([...PALETTE_DESCRIPTOR_NAMES]).toEqual(expect.arrayContaining(['Math', 'MermaidFence']));
  });

  test('exact size — adding a name requires intentional update of this list', () => {
    expect(PALETTE_DESCRIPTOR_NAMES.length).toBe(12);
  });
});

describe('PALETTE_DESCRIPTOR_NAMES — registry-derived non-portable coverage', () => {
  test('every descriptor that renders as a non-portable canonical has a palette name', () => {
    const descriptorNames = nonPortableDescriptorNames();

    expect(descriptorNames).toEqual(
      expect.arrayContaining(['Math', 'MermaidFence', 'DollarMath', 'MathFence']),
    );

    for (const name of descriptorNames) {
      expect([...PALETTE_DESCRIPTOR_NAMES], name).toContain(name);
    }
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
    for (const polluted of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const tone = toneForType(polluted);
      expect(tone, polluted).toBe(TYPE_TO_TONE.note);
      expect(tone.color).not.toBeUndefined();
      expect(tone.bg).not.toBeUndefined();
    }
  });
});

function stubCodeBlock(args: { language: string; meta?: string; textContent?: string }): PmNode {
  return {
    type: { name: 'codeBlock' },
    attrs: { language: args.language, meta: args.meta ?? '' },
    textContent: args.textContent ?? '',
  } as unknown as PmNode;
}

describe('paletteFor — preview-active codeBlock route', () => {
  let dom: JSDOM;
  const prevDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  beforeAll(() => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
    Object.defineProperty(globalThis, 'document', {
      value: dom.window.document,
      configurable: true,
      writable: true,
    });
  });
  afterAll(() => {
    if (prevDocument) Object.defineProperty(globalThis, 'document', prevDocument);
    else Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'document');
    dom.window.close();
  });

  test('preview-active html codeBlock → non-null clean source (guard present)', () => {
    const el = paletteFor(
      stubCodeBlock({ language: 'html', meta: 'preview', textContent: '<h1>Hi</h1>' }),
    );
    expect(el).not.toBeNull();
    expect(el?.textContent ?? '').toContain('<h1>Hi</h1>');
    expect(el?.querySelector('iframe')).toBeNull();
  });

  test('non-preview codeBlock → null (portable clean-clone path)', () => {
    const el = paletteFor(stubCodeBlock({ language: 'html', textContent: '<h1>Hi</h1>' }));
    expect(el).toBeNull();
  });
});

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
    expect(() => paletteUrlReason('http://')).toThrow();
  });

  test('byte-identical drift fence vs classifyUrlPortability', () => {
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
