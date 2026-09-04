import type { LinkPreviewMetadata } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { ExternalLinkPreviewCard } from './ExternalLinkPreviewCard';

afterEach(cleanup);

const FULL: LinkPreviewMetadata = {
  domain: 'example.com',
  title: 'Example Domain',
  description: 'This domain is for use in illustrative examples.',
  faviconDataUri: 'data:image/png;base64,iVBORw0KGgo=',
};

function slot(container: HTMLElement, name: string): HTMLElement | null {
  return container.querySelector(`[data-slot="external-link-preview-${name}"]`);
}

describe('ExternalLinkPreviewCard — present fields', () => {
  test('renders favicon (from the data URI), domain, title, and description', () => {
    const { container } = render(<ExternalLinkPreviewCard metadata={FULL} />);
    const favicon = slot(container, 'favicon');
    expect(favicon?.getAttribute('src')).toBe(FULL.faviconDataUri);
    expect(slot(container, 'domain')?.textContent).toBe('example.com');
    expect(screen.getByText('Example Domain')).toBeTruthy();
    expect(slot(container, 'description')?.textContent).toContain('illustrative examples');
  });
});

describe('ExternalLinkPreviewCard — progressive omission', () => {
  test('a metadata object with only a domain renders domain-only', () => {
    const { container } = render(<ExternalLinkPreviewCard metadata={{ domain: 'bare.test' }} />);
    expect(slot(container, 'domain')?.textContent).toBe('bare.test');
    expect(slot(container, 'favicon')).toBeNull();
    expect(slot(container, 'title')).toBeNull();
    expect(slot(container, 'description')).toBeNull();
  });

  test('an absent favicon omits the image but keeps the rest of the card', () => {
    const { faviconDataUri: _dropped, ...noFavicon } = FULL;
    const { container } = render(<ExternalLinkPreviewCard metadata={noFavicon} />);
    expect(slot(container, 'favicon')).toBeNull();
    expect(slot(container, 'domain')?.textContent).toBe('example.com');
    expect(screen.getByText('Example Domain')).toBeTruthy();
  });
});

describe('ExternalLinkPreviewCard — favicon safety', () => {
  test('a non-data:image favicon URI is never rendered as an image', () => {
    const hostile: LinkPreviewMetadata = {
      domain: 'example.com',
      faviconDataUri: 'https://tracker.example/pixel.gif',
    };
    const { container } = render(<ExternalLinkPreviewCard metadata={hostile} />);
    expect(slot(container, 'favicon')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(slot(container, 'domain')?.textContent).toBe('example.com');
  });
});
