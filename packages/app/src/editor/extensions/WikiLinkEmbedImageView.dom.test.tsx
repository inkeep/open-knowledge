import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, test } from 'vitest';
import { sharedExtensions } from './shared';
import { WikiLinkEmbedImageView } from './WikiLinkEmbedImageView';

function WikiImageHost() {
  const editor = useEditor({
    extensions: sharedExtensions,
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'wikiLinkEmbed',
              attrs: {
                target: 'attachments/broken.png',
                alias: 'Broken production wiki image',
                anchor: null,
                resolvedSrc: '/attachments/broken.png',
              },
            },
          ],
        },
      ],
    },
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

describe('WikiLinkEmbedImageView', () => {
  afterEach(() => {
    cleanup();
    delete (window as typeof window & { okDesktop?: unknown }).okDesktop;
  });

  test('a wiki image embed load failure uses the shared image placeholder', () => {
    render(<WikiLinkEmbedImageView src="/attachments/broken.png" alt="Broken wiki image" />);
    fireEvent.error(document.querySelector('img') as HTMLImageElement);

    const slot = screen.getByTestId('image-slot');
    expect(slot.getAttribute('data-image-error-kind')).toBe('undisplayable');
    expect(slot.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      "Image couldn't be displayed: Broken wiki image",
    );
  });

  test('the shared leaf keeps the Electron asset-origin rewrite', () => {
    const windowWithDesktop = window as typeof window & {
      okDesktop?: { config: { apiOrigin: string } };
    };
    windowWithDesktop.okDesktop = {
      config: { apiOrigin: 'http://127.0.0.1:54321' },
    };

    render(<WikiLinkEmbedImageView src="/attachments/photo.png" alt="Photo" />);
    expect(document.querySelector('img')?.getAttribute('src')).toBe(
      'http://127.0.0.1:54321/attachments/photo.png',
    );
  });

  test('the production WikiLinkEmbed image NodeView wires the shared placeholder', async () => {
    render(<WikiImageHost />);

    const wrapper = await waitFor(() => {
      const element = document.querySelector(
        '[data-wiki-embed][data-target="attachments/broken.png"]',
      );
      expect(element?.querySelector('img')).not.toBeNull();
      return element;
    });
    fireEvent.error(wrapper.querySelector('img') as HTMLImageElement);

    const slot = screen.getByTestId('image-slot');
    expect(slot.getAttribute('data-image-error-kind')).toBe('undisplayable');
    expect(slot.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      "Image couldn't be displayed: Broken production wiki image",
    );
  });
});
