import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';

// Exercises the real entry module, not just the root component: a blank
// uninstall window is the failure this seam exists to catch, and it can come
// from anywhere in the entry's import graph (an unresolvable module, a catalog
// that never activates, a mount that never runs) — not only from the screen.
test('the uninstall entry paints content into the document', async () => {
  document.body.innerHTML = '<div id="root"></div>';

  await import('./main');

  const root = document.getElementById('root');
  await waitFor(() => {
    expect(root?.children.length ?? 0).toBeGreaterThan(0);
    expect(root?.textContent?.trim()).not.toBe('');
  });
});
