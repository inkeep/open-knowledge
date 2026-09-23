import { describe, expect, it } from 'vitest';
import { installDocumentTeardownObserver } from './install-document-teardown-observer';

type Listener = (event: Event) => void;

function makeFakeTarget() {
  const listeners = new Map<string, Listener>();
  return {
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string) {
      listeners.delete(type);
    },
    emit(type: string, props: Record<string, unknown> = {}) {
      listeners.get(type)?.(Object.assign(new Event(type), props));
    },
  };
}

function makeFakeDoc(visibilityState: DocumentVisibilityState) {
  const target = makeFakeTarget();
  return Object.assign(target, {
    visibilityState,
    setVisibility(v: DocumentVisibilityState) {
      (this as { visibilityState: DocumentVisibilityState }).visibilityState = v;
    },
  });
}

function makeObserver(initialVisibility: DocumentVisibilityState = 'visible') {
  const win = makeFakeTarget();
  const doc = makeFakeDoc(initialVisibility);
  return { win, doc, observer: installDocumentTeardownObserver({ win, doc }) };
}

describe('installDocumentTeardownObserver', () => {
  it('reports unloading once a pagehide announces the document will be destroyed', () => {
    const { win, observer } = makeObserver();
    expect(observer.isUnloading()).toBe(false);

    win.emit('pagehide', { persisted: false });

    expect(observer.isUnloading()).toBe(true);
  });

  it('does not report unloading for a pagehide that retains the document in the back/forward cache', () => {
    const { win, observer } = makeObserver();

    win.emit('pagehide', { persisted: true });

    expect(observer.isUnloading()).toBe(false);

    win.emit('pagehide', { persisted: false });

    expect(observer.isUnloading()).toBe(true);
  });

  it('does not report unloading for a pagehide that carries no persisted flag', () => {
    const { win, observer } = makeObserver();

    win.emit('pagehide');

    expect(observer.isUnloading()).toBe(false);

    win.emit('pagehide', { persisted: false });

    expect(observer.isUnloading()).toBe(true);
  });

  it('does not report unloading when the tab is merely switched away from', () => {
    const { win, doc, observer } = makeObserver();

    doc.setVisibility('hidden');
    doc.emit('visibilitychange');

    expect(observer.isUnloading()).toBe(false);

    win.emit('pagehide', { persisted: false });

    expect(observer.isUnloading()).toBe(true);

    doc.setVisibility('visible');
    doc.emit('visibilitychange');

    expect(observer.isUnloading()).toBe(false);
  });

  it('keeps reporting unloading through the hidden visibilitychange that unload fires after pagehide', () => {
    const { win, doc, observer } = makeObserver();

    win.emit('pagehide', { persisted: false });
    expect(observer.isUnloading()).toBe(true);

    doc.setVisibility('hidden');
    doc.emit('visibilitychange');

    expect(observer.isUnloading()).toBe(true);
  });

  it('stops reporting unloading once a restored document announces pageshow', () => {
    const { win, observer } = makeObserver();
    win.emit('pagehide', { persisted: false });
    expect(observer.isUnloading()).toBe(true);

    win.emit('pageshow');

    expect(observer.isUnloading()).toBe(false);
  });

  it('ignores a pagehide delivered after uninstall', () => {
    const { win, observer } = makeObserver();
    win.emit('pagehide', { persisted: false });
    expect(observer.isUnloading()).toBe(true);
    win.emit('pageshow');
    expect(observer.isUnloading()).toBe(false);

    observer.uninstall();
    win.emit('pagehide', { persisted: false });

    expect(observer.isUnloading()).toBe(false);
  });

  it('ignores the restore signals delivered after uninstall', () => {
    const { win, doc, observer } = makeObserver();
    win.emit('pagehide', { persisted: false });
    expect(observer.isUnloading()).toBe(true);

    observer.uninstall();
    win.emit('pageshow');
    doc.setVisibility('visible');
    doc.emit('visibilitychange');

    expect(observer.isUnloading()).toBe(true);
  });

  it('never reports unloading when there is no document to observe', () => {
    const observer = installDocumentTeardownObserver();

    expect(observer.isUnloading()).toBe(false);
    expect(() => observer.uninstall()).not.toThrow();
    expect(observer.isUnloading()).toBe(false);
  });
});
