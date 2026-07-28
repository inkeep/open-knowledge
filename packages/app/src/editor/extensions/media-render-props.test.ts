import { describe, expect, test } from 'vitest';
import { normalizeDocRelativeMediaRenderProps } from './media-render-props.ts';

describe('normalizeDocRelativeMediaRenderProps', () => {
  test('resolves ./ image src against a root document', () => {
    expect(
      normalizeDocRelativeMediaRenderProps(
        'img',
        { src: './pasted-20260520-165209.png' },
        'README',
      ),
    ).toEqual({ src: '/pasted-20260520-165209.png' });
  });

  test('resolves ./ image src against the current document directory', () => {
    expect(
      normalizeDocRelativeMediaRenderProps(
        'img',
        { src: './pasted-20260520-165209.png' },
        'notes/today',
      ),
    ).toEqual({ src: '/notes/pasted-20260520-165209.png' });
  });

  test('resolves ../ image src against the current document directory', () => {
    expect(
      normalizeDocRelativeMediaRenderProps(
        'img',
        { src: '../pasted-20260520-165209.png' },
        'notes/today',
      ),
    ).toEqual({ src: '/pasted-20260520-165209.png' });
  });

  test('leaves absolute and remote image src values unchanged', () => {
    const absolute = { src: '/pasted-20260520-165209.png' };
    const remote = { src: 'https://example.com/pasted.png' };

    expect(normalizeDocRelativeMediaRenderProps('img', absolute, 'notes/today')).toBe(absolute);
    expect(normalizeDocRelativeMediaRenderProps('img', remote, 'notes/today')).toBe(remote);
  });

  test('does not guess without a source document', () => {
    const props = { src: './pasted-20260520-165209.png' };
    expect(normalizeDocRelativeMediaRenderProps('img', props, null)).toBe(props);
  });

  test('does not rewrite non-image component props', () => {
    const props = { src: './pasted-20260520-165209.png' };
    expect(normalizeDocRelativeMediaRenderProps('Callout', props, 'notes/today')).toBe(props);
  });

  test('resolves ./ image src for CommonMarkImage descriptor', () => {
    expect(
      normalizeDocRelativeMediaRenderProps(
        'CommonMarkImage',
        { src: './pasted-20260520-165209.png' },
        'notes/today',
      ),
    ).toEqual({ src: '/notes/pasted-20260520-165209.png' });
  });

  test('resolves ./ media src for video and audio descriptors', () => {
    expect(
      normalizeDocRelativeMediaRenderProps('video', { src: './demo.mp4' }, 'notes/today'),
    ).toEqual({ src: '/notes/demo.mp4' });
    expect(
      normalizeDocRelativeMediaRenderProps('audio', { src: './song.mp3' }, 'notes/today'),
    ).toEqual({ src: '/notes/song.mp3' });
  });

  test('resolves relative PDF src against the current document directory', () => {
    expect(
      normalizeDocRelativeMediaRenderProps('Pdf', { src: './test.pdf' }, 'notes/today'),
    ).toEqual({
      src: '/notes/test.pdf',
    });
    expect(
      normalizeDocRelativeMediaRenderProps('Pdf', { src: '../test.pdf' }, 'notes/archive/today'),
    ).toEqual({ src: '/notes/test.pdf' });
  });

  test('resolves relative File src against the current document directory', () => {
    expect(
      normalizeDocRelativeMediaRenderProps('File', { src: './document.docx' }, 'notes/today'),
    ).toEqual({ src: '/notes/document.docx' });
    expect(
      normalizeDocRelativeMediaRenderProps(
        'File',
        { src: '../archive.zip' },
        'notes/archive/today',
      ),
    ).toEqual({ src: '/notes/archive.zip' });
  });
});
