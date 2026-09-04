import type { HocuspocusProvider } from '@hocuspocus/provider';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { FULL_PAGE_CM_HOST_SELECTORS } from '@/globals-css.test-helper';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

vi.doMock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.doMock('@/editor/components/Mermaid', () => ({
  MermaidView: () => <div data-testid="mermaid-view" />,
}));

const { MermaidDocEditor } = await import('./MermaidDocEditor');

afterEach(cleanup);

describe('MermaidDocEditor host contract', () => {
  test('renders the host attribute used by the composer-inset selector', () => {
    const document = new Y.Doc();
    const awareness = new Awareness(document);
    const provider = {
      document,
      awareness,
      on() {},
      off() {},
    } as unknown as HocuspocusProvider;

    const { container, unmount } = render(
      <MermaidDocEditor docName="diagram.mmd" provider={provider} isSourceMode={false} />,
    );

    expect(container.querySelector(FULL_PAGE_CM_HOST_SELECTORS.mermaidDocEditor)).not.toBeNull();

    unmount();
    awareness.destroy();
    document.destroy();
  });
});
