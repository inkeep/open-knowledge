import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

const copyImage = vi.fn();
vi.mock('@/lib/copy-image', () => ({ copyImage }));

beforeAll(async () => {
  await import('./copy-image.ts');
});

afterEach(() => {
  document.body.innerHTML = '';
  copyImage.mockReset();
  vi.restoreAllMocks();
});

function copyFrom(target: Element): Event {
  const event = new Event('copy', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function editorImage(attrs: { src: string }): HTMLImageElement {
  const editor = document.createElement('div');
  editor.className = 'ProseMirror';
  const img = document.createElement('img');
  img.src = attrs.src;
  editor.append(img);
  document.body.append(editor);
  return img;
}

describe('copy-image listener', () => {
  test('a copy on an editor image hands its src to the copy-image service', () => {
    copyImage.mockResolvedValue({ ok: true, via: 'browser' });
    const event = copyFrom(editorImage({ src: 'http://localhost:5173/a.png' }));
    expect(event.defaultPrevented).toBe(true);
    expect(copyImage).toHaveBeenCalledWith({ src: 'http://localhost:5173/a.png' });
  });

  test('an image outside the editor keeps the default copy', () => {
    const img = document.createElement('img');
    img.src = 'http://localhost:5173/a.png';
    document.body.append(img);
    const event = copyFrom(img);
    expect(event.defaultPrevented).toBe(false);
    expect(copyImage).not.toHaveBeenCalled();
  });

  test('a copy of editor text keeps the default copy', () => {
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    const p = document.createElement('p');
    p.textContent = 'hello';
    editor.append(p);
    document.body.append(editor);
    const event = copyFrom(p);
    expect(event.defaultPrevented).toBe(false);
    expect(copyImage).not.toHaveBeenCalled();
  });

  test('a desktop fallback and a failed browser write are both logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    copyImage.mockResolvedValue({
      ok: false,
      reason: 'write-error',
      detail: 'NotAllowedError',
      desktopFailure: { ok: false, reason: 'empty-image', detail: 'svg' },
    });
    copyFrom(editorImage({ src: 'http://localhost:5173/a.svg' }));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    expect(warn.mock.calls.map((call) => call[1])).toEqual(['empty-image', 'write-error']);
  });
});
