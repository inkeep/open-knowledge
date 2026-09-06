import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { DownloadButton } from '@/components/download-button';
import { downloadLabelForOs } from '@/lib/download-targets';

const html = renderToStaticMarkup(<DownloadButton />);

describe('the docs download button before hydration', () => {
  test('names no platform', () => {
    expect(html).toContain(`>${downloadLabelForOs('unknown')}<`);
    for (const os of ['macos', 'windows', 'linux'] as const) {
      expect(html).not.toContain(downloadLabelForOs(os));
    }
  });

  test('links a build the visitor can run without script', () => {
    const hrefs = html.replaceAll('&amp;', '&');
    expect(hrefs).toContain('os=macos&arch=arm64&format=dmg');
  });
});
