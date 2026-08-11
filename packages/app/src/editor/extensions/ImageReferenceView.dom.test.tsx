import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, test } from 'vitest';
import { ImageReferenceLeaf } from './ImageReferenceView';
import { sharedExtensions } from './shared';

function Host({ content }: { content: object }) {
  const editor = useEditor({
    extensions: sharedExtensions.map((extension) =>
      extension.name === 'imageReference'
        ? extension.configure({ docName: 'all-link-types' })
        : extension,
    ),
    content,
    immediatelyRender: true,
  });
  const [portalTarget] = useState(() => document.createElement('div'));

  useEffect(() => {
    document.body.appendChild(portalTarget);
    return () => portalTarget.remove();
  }, [portalTarget]);

  return createPortal(
    // biome-ignore lint/plugin/no-unportaled-editor-content: portalled per the H6 contract — this IS the sanctioned createPortal shape, in a test harness with a per-render exclusive target
    <EditorContent editor={editor} />,
    portalTarget,
  );
}

function referenceImageDoc() {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'imageReference',
            attrs: {
              alt: 'Working reference image',
              label: 'valid-image',
              identifier: 'valid-image',
              referenceType: 'full',
            },
          },
        ],
      },
      {
        type: 'linkRefDef',
        attrs: { label: 'valid-image', href: 'assets/working.png' },
      },
    ],
  };
}

describe('ImageReferenceLeaf', () => {
  afterEach(cleanup);

  test('a reference-style Markdown image failure uses the shared image placeholder', () => {
    render(<ImageReferenceLeaf src="/assets/missing.png" alt="Missing reference image" />);
    fireEvent.error(document.querySelector('img') as HTMLImageElement);

    const slot = screen.getByTestId('image-slot');
    expect(slot.getAttribute('data-image-error-kind')).toBe('undisplayable');
    expect(slot.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      "Image couldn't be displayed: Missing reference image",
    );
  });

  test('a reference-style image without a matching definition renders a not-found placeholder', () => {
    render(<ImageReferenceLeaf alt="Undefined reference image" />);

    const slot = screen.getByTestId('image-slot');
    expect(slot.getAttribute('data-image-error-kind')).toBe('not-found');
    expect(slot.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      'Image not found: Undefined reference image',
    );
  });
});

describe('ImageReferenceView', () => {
  afterEach(cleanup);

  test('normalizes a local definition href against the configured document on initial render', async () => {
    const desktopWindow = window as typeof window & {
      okDesktop?: { config: { apiOrigin: string } };
    };
    desktopWindow.okDesktop = { config: { apiOrigin: 'http://localhost:53351' } };

    try {
      render(<Host content={referenceImageDoc()} />);

      await waitFor(() => {
        expect(
          document
            .querySelector<HTMLImageElement>('span[data-image-reference-view] img')
            ?.getAttribute('src'),
        ).toBe('http://localhost:53351/assets/working.png');
      });
    } finally {
      delete desktopWindow.okDesktop;
    }
  });
});
