import { afterEach, describe, expect, test, vi } from 'vitest';
import { getCollector } from './collector';
import { BUNDLED_TRACKS, mark } from './mark';

function captureBreadcrumbs() {
  const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  return {
    parsed(): Array<Record<string, unknown>> {
      return spy.mock.calls.flatMap(([first]) => {
        if (typeof first !== 'string') return [];
        try {
          return [JSON.parse(first) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
    },
    spy,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  getCollector()?.reset();
});

describe('marks routed into diagnostic bundles', () => {
  test('a scroll-restore mark writes a breadcrumb keyed by the mark name', () => {
    const { parsed } = captureBreadcrumbs();
    mark('ok/scroll-restore/abandoned', {
      docName: 'notes/tall',
      target: 4200,
      scrollTop: 120,
      scrollHeight: 4800,
      clientHeight: 900,
      anchorMeasurable: true,
    });
    expect(parsed()).toEqual([
      {
        event: 'ok/scroll-restore/abandoned',
        docName: 'notes/tall',
        target: 4200,
        scrollTop: 120,
        scrollHeight: 4800,
        clientHeight: 900,
        anchorMeasurable: true,
      },
    ]);
  });

  test('a mark with no props still reaches the log', () => {
    const { parsed } = captureBreadcrumbs();
    mark('ok/scroll-restore/phase1-success');
    expect(parsed()).toEqual([{ event: 'ok/scroll-restore/phase1-success' }]);
  });

  test('an unlisted track writes no breadcrumb', () => {
    const { spy } = captureBreadcrumbs();
    mark('ok/nav/hash-change', { docName: 'notes/a' });
    mark('ok/sync/resolve', { docName: 'notes/a' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('every mark still reaches the collector, listed or not', () => {
    captureBreadcrumbs();
    mark('ok/scroll-restore/cross-mode', { docName: 'notes/a' });
    mark('ok/nav/hash-change', { docName: 'notes/a' });
    const names = getCollector()
      ?.marks.toArray()
      .map((m) => m.name);
    expect(names).toContain('ok/scroll-restore/cross-mode');
    expect(names).toContain('ok/nav/hash-change');
  });

  test('the allowlist holds exactly the one family that is safe to write per emission', () => {
    expect([...BUNDLED_TRACKS]).toEqual(['ok/scroll-restore']);
  });

  test('membership is by whole track, so a lookalike prefix does not opt in', () => {
    const { spy } = captureBreadcrumbs();
    mark('ok/scroll/restore-ish', { docName: 'notes/a' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('the breadcrumb does not depend on the DevTools measure API existing', () => {
    const { parsed } = captureBreadcrumbs();
    Object.defineProperty(performance, 'measure', { value: undefined, configurable: true });
    try {
      mark('ok/scroll-restore/phase2-success', { docName: 'notes/a', target: 100 });
    } finally {
      Reflect.deleteProperty(performance, 'measure');
    }
    expect(typeof performance.measure).toBe('function');
    expect(parsed()).toEqual([
      { event: 'ok/scroll-restore/phase2-success', docName: 'notes/a', target: 100 },
    ]);
  });
});
