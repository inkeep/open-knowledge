import { waitFor } from '@testing-library/react';

const PIERRE_CONTENT_ROW_SELECTOR = '[data-content] [data-line]';

export async function pierreShadow(container: HTMLElement): Promise<ShadowRoot> {
  await waitFor(
    () => {
      const root = container.querySelector('diffs-container')?.shadowRoot;
      if (root?.querySelector(PIERRE_CONTENT_ROW_SELECTOR) == null) {
        throw new Error('Pierre has not painted any content rows into the shadow root yet');
      }
    },
    { timeout: 5_000 },
  );
  return container.querySelector('diffs-container')?.shadowRoot as ShadowRoot;
}
