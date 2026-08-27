/**
 * The route from a perf mark to a diagnostic bundle.
 *
 * `mark`'s two original sinks are both unreachable after the fact —
 * `performance.measure` needs DevTools attached at the time, and the collector
 * ring is compiled out of production. A track on `BUNDLED_TRACKS` additionally
 * writes a renderer breadcrumb, which is the only one of the three that survives
 * into a log file a user can upload.
 */

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
    // The event IS the mark name, so one string finds the mark in a DevTools
    // trace and the line in a bundle.
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
    // Locked deliberately, not descriptively. A breadcrumb is one log line per
    // emission with no sampling or cap, so a track only belongs here when every
    // mark under it is at-most-once per session. `ok/scroll-restore` is: its
    // five events fire once per restore, guarded by `phase2Marked` /
    // `hasLandedOnce` / a single backstop timer.
    //
    // The tracks one careless edit away are not: `ok/cold` wraps a ProseMirror
    // `decorations` prop, so it emits per transaction — per keystroke — and
    // would age the 45 MB log-directory cap out from under the very session
    // being diagnosed. `ok/vitals` and `ok/cold` also build their names
    // dynamically, so nothing here could enumerate them anyway.
    expect([...BUNDLED_TRACKS]).toEqual(['ok/scroll-restore']);
  });

  test('membership is by whole track, so a lookalike prefix does not opt in', () => {
    const { spy } = captureBreadcrumbs();
    mark('ok/scroll/restore-ish', { docName: 'notes/a' });
    expect(spy).not.toHaveBeenCalled();
  });

  test('the breadcrumb does not depend on the DevTools measure API existing', () => {
    // The breadcrumb is the only sink here that survives to a file a user can
    // send us. Ordering it behind the `performance.measure` guard would rebuild
    // the dependency on DevTools that routing these marks to disk exists to
    // break — and the guard is exactly what a hardened or headless embedder
    // trips.
    const { parsed } = captureBreadcrumbs();
    // `measure` lives on Performance.prototype, so there is no own descriptor to
    // save and restore — shadow it with an own property, then delete that to
    // uncover the prototype's. Restoring by descriptor would silently no-op and
    // leave `performance.measure` undefined for every later test in the file.
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
