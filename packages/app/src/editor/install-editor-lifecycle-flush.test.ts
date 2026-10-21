import { describe, expect, it, vi } from 'vitest';
import { installEditorLifecycleFlush, RESUME_THROTTLE_MS } from './install-editor-lifecycle-flush';

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
    emit(type: string) {
      listeners.get(type)?.(new Event(type));
    },
    has(type: string) {
      return listeners.has(type);
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

describe('installEditorLifecycleFlush', () => {
  it('flushes on pagehide', () => {
    const onHide = vi.fn();
    const onVisible = vi.fn();
    const win = makeFakeTarget();
    const doc = makeFakeDoc('visible');
    installEditorLifecycleFlush({ onHide, onVisible, win, doc });

    win.emit('pagehide');

    expect(onHide).toHaveBeenCalledTimes(1);
    expect(onVisible).not.toHaveBeenCalled();
  });

  it('flushes on visibilitychange when hidden', () => {
    const onHide = vi.fn();
    const onVisible = vi.fn();
    const win = makeFakeTarget();
    const doc = makeFakeDoc('hidden');
    installEditorLifecycleFlush({ onHide, onVisible, win, doc });

    doc.emit('visibilitychange');

    expect(onHide).toHaveBeenCalledTimes(1);
    expect(onVisible).not.toHaveBeenCalled();
  });

  it('resyncs on visibilitychange when visible', () => {
    const onHide = vi.fn();
    const onVisible = vi.fn();
    const win = makeFakeTarget();
    const doc = makeFakeDoc('visible');
    installEditorLifecycleFlush({ onHide, onVisible, win, doc });

    doc.emit('visibilitychange');

    expect(onVisible).toHaveBeenCalledTimes(1);
    expect(onHide).not.toHaveBeenCalled();
  });

  it('runs the hide work once for a real tab close, not once per listener', () => {
    const onHide = vi.fn();
    const onVisible = vi.fn();
    const win = makeFakeTarget();
    const doc = makeFakeDoc('visible');
    installEditorLifecycleFlush({ onHide, onVisible, win, doc });

    doc.setVisibility('hidden');
    doc.emit('visibilitychange');
    win.emit('pagehide');

    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('re-arms the hide after the tab becomes visible again', () => {
    const onHide = vi.fn();
    const onVisible = vi.fn();
    const win = makeFakeTarget();
    const doc = makeFakeDoc('visible');
    installEditorLifecycleFlush({ onHide, onVisible, win, doc });

    doc.setVisibility('hidden');
    doc.emit('visibilitychange');
    expect(onHide).toHaveBeenCalledTimes(1);

    doc.setVisibility('visible');
    doc.emit('visibilitychange');
    doc.setVisibility('hidden');
    doc.emit('visibilitychange');

    expect(onVisible).toHaveBeenCalledTimes(1);
    expect(onHide).toHaveBeenCalledTimes(2);
  });

  it('removes both listeners on uninstall', () => {
    const onHide = vi.fn();
    const onVisible = vi.fn();
    const win = makeFakeTarget();
    const doc = makeFakeDoc('hidden');
    const uninstall = installEditorLifecycleFlush({ onHide, onVisible, win, doc });

    uninstall();

    expect(win.has('pagehide')).toBe(false);
    expect(doc.has('visibilitychange')).toBe(false);
    win.emit('pagehide');
    doc.emit('visibilitychange');
    expect(onHide).not.toHaveBeenCalled();
    expect(onVisible).not.toHaveBeenCalled();
  });

  it('is a safe no-op when globals are absent', () => {
    const onHide = vi.fn();
    const onVisible = vi.fn();
    const uninstall = installEditorLifecycleFlush({ onHide, onVisible });
    expect(() => uninstall()).not.toThrow();
    expect(onHide).not.toHaveBeenCalled();
  });

  it('asks for a re-read from disk when the window regains focus', () => {
    const onResume = vi.fn();
    const win = makeFakeTarget();
    const doc = makeFakeDoc('visible');
    let clock = 10_000;
    installEditorLifecycleFlush({
      onHide: vi.fn(),
      onVisible: vi.fn(),
      onResume,
      now: () => clock,
      win,
      doc,
    });

    win.emit('focus');
    expect(onResume).toHaveBeenCalledTimes(1);

    clock += RESUME_THROTTLE_MS;
    win.emit('focus');
    expect(onResume).toHaveBeenCalledTimes(2);
  });

  it('asks once when the tab becomes visible and the window takes focus together', () => {
    const onResume = vi.fn();
    const onVisible = vi.fn();
    const win = makeFakeTarget();
    const doc = makeFakeDoc('visible');
    installEditorLifecycleFlush({
      onHide: vi.fn(),
      onVisible,
      onResume,
      now: () => 10_000,
      win,
      doc,
    });

    doc.emit('visibilitychange');
    win.emit('focus');

    expect(onVisible).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('does not ask while the page is hidden, and stops asking once uninstalled', () => {
    const onResume = vi.fn();
    const win = makeFakeTarget();
    const doc = makeFakeDoc('hidden');
    let clock = 10_000;
    const uninstall = installEditorLifecycleFlush({
      onHide: vi.fn(),
      onVisible: vi.fn(),
      onResume,
      now: () => clock,
      win,
      doc,
    });

    win.emit('focus');
    expect(onResume).not.toHaveBeenCalled();

    doc.setVisibility('visible');
    win.emit('focus');
    expect(onResume).toHaveBeenCalledTimes(1);

    uninstall();
    clock += RESUME_THROTTLE_MS;
    expect(win.has('focus')).toBe(false);
    win.emit('focus');
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
