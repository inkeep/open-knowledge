import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';

test('the uninstall entry paints content into the document', async () => {
  document.body.innerHTML = '<div id="root"></div>';

  await import('./main');

  const root = document.getElementById('root');
  await waitFor(() => {
    expect(root?.children.length ?? 0).toBeGreaterThan(0);
    expect(root?.textContent?.trim()).not.toBe('');
  });
});
