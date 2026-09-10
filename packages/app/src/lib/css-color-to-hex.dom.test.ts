import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('recreates a failed canvas and reports distinct failures without repeating each frame', async () => {
  vi.resetModules();
  const { cssColorToHex } = await import('./css-color-to-hex');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const getImageData = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error('canvas unavailable');
    })
    .mockImplementationOnce(() => {
      throw new Error('canvas unavailable');
    })
    .mockImplementationOnce(() => {
      throw new Error('readback denied');
    })
    .mockReturnValueOnce({ data: new Uint8ClampedArray([255, 255, 255, 255]) })
    .mockImplementationOnce(() => {
      throw new Error('readback denied');
    })
    .mockReturnValue({ data: new Uint8ClampedArray([255, 255, 255, 255]) });
  const createElement = vi.fn(() => ({
    width: 0,
    height: 0,
    getContext: () => ({
      fillStyle: '',
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      getImageData,
    }),
  }));
  vi.stubGlobal('document', { createElement });

  const value = 'oklch(1 0 0)';
  expect(cssColorToHex(value)).toBeNull();
  expect(cssColorToHex(value)).toBeNull();
  expect(cssColorToHex(value)).toBeNull();
  expect(cssColorToHex(value)).toBe('#ffffff');
  expect(cssColorToHex(value)).toBeNull();
  expect(cssColorToHex(value)).toBe('#ffffff');
  expect(createElement).toHaveBeenCalledTimes(5);
  expect(warn.mock.calls).toEqual(
    ['canvas unavailable', 'readback denied', 'readback denied'].map((error) => [
      JSON.stringify({ event: 'css-color-to-hex-canvas-failed', error, value }),
    ]),
  );
});
