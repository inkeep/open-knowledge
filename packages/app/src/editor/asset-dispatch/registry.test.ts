import { describe, expect, test, vi } from 'vitest';
import { AssetViewerRegistry } from './registry.ts';

function makeViewer(exts: readonly string[]): {
  exts: readonly string[];
  render: ReturnType<typeof vi.fn>;
} {
  return { exts, render: vi.fn(() => {}) };
}

describe('AssetViewerRegistry', () => {
  test('lookup on empty registry returns ok:false', () => {
    const r = new AssetViewerRegistry();
    expect(r.lookup('pdf')).toEqual({ ok: false });
  });

  test('register + lookup returns ok:true with the viewer', () => {
    const r = new AssetViewerRegistry();
    const viewer = makeViewer(['pdf']);
    r.register(viewer);
    expect(r.lookup('pdf')).toEqual({ ok: true, viewer });
  });

  test('lookup is case-insensitive on the ext parameter', () => {
    const r = new AssetViewerRegistry();
    const viewer = makeViewer(['pdf']);
    r.register(viewer);
    expect(r.lookup('PDF')).toEqual({ ok: true, viewer });
  });

  test('register normalizes its declared exts to lowercase', () => {
    const r = new AssetViewerRegistry();
    const viewer = makeViewer(['PDF']);
    r.register(viewer);
    expect(r.lookup('pdf')).toEqual({ ok: true, viewer });
  });

  test('a viewer with multiple exts is findable under each', () => {
    const r = new AssetViewerRegistry();
    const viewer = makeViewer(['png', 'jpg', 'webp']);
    r.register(viewer);
    expect(r.lookup('png')).toEqual({ ok: true, viewer });
    expect(r.lookup('jpg')).toEqual({ ok: true, viewer });
    expect(r.lookup('webp')).toEqual({ ok: true, viewer });
  });

  describe('register returns an unregister fn', () => {
    test('unregister removes the viewer from the registry', () => {
      const r = new AssetViewerRegistry();
      const viewer = makeViewer(['pdf']);
      const unregister = r.register(viewer);
      expect(r.lookup('pdf')).toEqual({ ok: true, viewer });
      unregister();
      expect(r.lookup('pdf')).toEqual({ ok: false });
    });

    test('unregister removes ALL extensions a multi-ext viewer claimed', () => {
      const r = new AssetViewerRegistry();
      const viewer = makeViewer(['png', 'jpg', 'webp']);
      const unregister = r.register(viewer);
      unregister();
      expect(r.lookup('png')).toEqual({ ok: false });
      expect(r.lookup('jpg')).toEqual({ ok: false });
      expect(r.lookup('webp')).toEqual({ ok: false });
    });

    test('double-unregister is a benign no-op', () => {
      const r = new AssetViewerRegistry();
      const viewer = makeViewer(['pdf']);
      const unregister = r.register(viewer);
      unregister();
      expect(() => unregister()).not.toThrow();
      expect(r.lookup('pdf')).toEqual({ ok: false });
    });

    test('unregister leaves other viewers alone', () => {
      const r = new AssetViewerRegistry();
      const pdfViewer = makeViewer(['pdf']);
      const pngViewer = makeViewer(['png']);
      const unregisterPdf = r.register(pdfViewer);
      r.register(pngViewer);
      unregisterPdf();
      expect(r.lookup('pdf')).toEqual({ ok: false });
      expect(r.lookup('png')).toEqual({ ok: true, viewer: pngViewer });
    });
  });

  describe('idempotent same-instance re-registration', () => {
    test('re-registering the same viewer instance is silent', () => {
      const r = new AssetViewerRegistry();
      const viewer = makeViewer(['pdf']);
      const consoleWarn = vi.fn((..._args: unknown[]) => {});
      const origWarn = console.warn;
      console.warn = consoleWarn as unknown as typeof console.warn;
      try {
        r.register(viewer);
        r.register(viewer);
        r.register(viewer);
      } finally {
        console.warn = origWarn;
      }
      expect(consoleWarn).not.toHaveBeenCalled();
      expect(r.lookup('pdf')).toEqual({ ok: true, viewer });
    });

    test('re-registering the same viewer instance returns the same unregister fn', () => {
      const r = new AssetViewerRegistry();
      const viewer = makeViewer(['pdf']);
      const first = r.register(viewer);
      const second = r.register(viewer);
      expect(second).toBe(first);
    });
  });

  describe('different-instance collision on shared extension', () => {
    test('emits a structured warn when a different viewer claims an existing ext', () => {
      const r = new AssetViewerRegistry();
      const first = makeViewer(['pdf']);
      const second = makeViewer(['pdf']);
      const consoleWarn = vi.fn((..._args: unknown[]) => {});
      const origWarn = console.warn;
      console.warn = consoleWarn as unknown as typeof console.warn;
      try {
        r.register(first);
        r.register(second);
      } finally {
        console.warn = origWarn;
      }
      expect(consoleWarn).toHaveBeenCalledTimes(1);
      const arg = consoleWarn.mock.calls[0]?.[0] as string | undefined;
      expect(arg).toBeDefined();
      expect(typeof arg).toBe('string');
      const parsed = JSON.parse(arg as string);
      expect(parsed.event).toBe('asset-viewer-collision');
      expect(parsed.ext).toBe('pdf');
      expect(parsed.priorExts).toEqual(['pdf']);
      expect(parsed.newExts).toEqual(['pdf']);
    });

    test('last-registered wins per Map.set semantics', () => {
      const r = new AssetViewerRegistry();
      const first = makeViewer(['pdf']);
      const second = makeViewer(['pdf']);
      const origWarn = console.warn;
      console.warn = (() => {}) as typeof console.warn;
      try {
        r.register(first);
        r.register(second);
      } finally {
        console.warn = origWarn;
      }
      expect(r.lookup('pdf')).toEqual({ ok: true, viewer: second });
    });

    test('unregistering a displaced viewer does not remove the replacement', () => {
      const r = new AssetViewerRegistry();
      const first = makeViewer(['pdf']);
      const second = makeViewer(['pdf']);
      const unregisterFirst = r.register(first);
      const origWarn = console.warn;
      console.warn = (() => {}) as typeof console.warn;
      try {
        r.register(second);
      } finally {
        console.warn = origWarn;
      }
      unregisterFirst();
      expect(r.lookup('pdf')).toEqual({ ok: true, viewer: second });
    });
  });

  describe('clearForTests', () => {
    test('empties the registry', () => {
      const r = new AssetViewerRegistry();
      r.register(makeViewer(['pdf']));
      r.clearForTests();
      expect(r.lookup('pdf')).toEqual({ ok: false });
    });

    test('allows re-registering the same viewer instance after clear', () => {
      const r = new AssetViewerRegistry();
      const viewer = makeViewer(['pdf']);
      r.register(viewer);
      r.clearForTests();
      const unregister = r.register(viewer);
      expect(r.lookup('pdf')).toEqual({ ok: true, viewer });
      unregister();
      expect(r.lookup('pdf')).toEqual({ ok: false });
    });
  });
});
