import { describe, expect, test } from 'bun:test';
import { extractBase64Images } from './base64-images.ts';

// 1x1 transparent PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('extractBase64Images', () => {
  test('extracts an empty-text data-image link into a file and rewrites as an image embed', () => {
    const input = `Before\n\n[](data:image/png;base64,${PNG_B64})\n\nAfter`;
    const { markdown, assets } = extractBase64Images(input, 'My Page 2ee45f35b5ad80.md');
    expect(assets).toHaveLength(1);
    expect(assets[0]?.filename).toBe('my-page-2ee45f35b5ad80-inline-1.png');
    expect(assets[0]?.bytes.length).toBeGreaterThan(0);
    expect(markdown).toContain('![](my-page-2ee45f35b5ad80-inline-1.png)');
    expect(markdown).not.toContain('data:image');
  });

  test('numbers multiple blobs deterministically', () => {
    const input = `![a](data:image/png;base64,${PNG_B64})\n![b](data:image/gif;base64,${PNG_B64})`;
    const { markdown, assets } = extractBase64Images(input, 'page.md');
    expect(assets.map((a) => a.filename)).toEqual(['page-inline-1.png', 'page-inline-2.gif']);
    expect(markdown).toContain('![a](page-inline-1.png)');
    expect(markdown).toContain('![b](page-inline-2.gif)');
  });

  test('strip mode removes the blob and writes no asset', () => {
    const input = `x [](data:image/png;base64,${PNG_B64}) y`;
    const { markdown, assets } = extractBase64Images(input, 'page.md', { strip: true });
    expect(assets).toHaveLength(0);
    expect(markdown).toBe('x  y');
    expect(markdown).not.toContain('data:image');
  });

  test('is idempotent — no data: blobs remain after extraction', () => {
    const input = `[](data:image/png;base64,${PNG_B64})`;
    const first = extractBase64Images(input, 'page.md');
    const second = extractBase64Images(first.markdown, 'page.md');
    expect(second.markdown).toBe(first.markdown);
    expect(second.assets).toHaveLength(0);
  });

  test('leaves markdown with no data-image blobs unchanged', () => {
    const input = '# Title\n\n![real](photo.png)\n';
    const { markdown, assets } = extractBase64Images(input, 'page.md');
    expect(markdown).toBe(input);
    expect(assets).toHaveLength(0);
  });
});
