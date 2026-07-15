/**
 * DOM tests for InternalDocPreviewCard (the W2 doc card). Asserts the
 * present-field rendering and, above all, the progressive-omission contract:
 * a field the reader has not resolved (excerpt/tags/backlinks still loading or
 * failed) is omitted, an empty-body excerpt ('') shows the "No excerpt"
 * affordance, and the always-local title/folder render regardless.
 *
 * Lingui macros resolve to the English-passthrough shim under `test:dom`
 * (`tests/lingui-macro-preload.ts`), so assertions read source-locale text.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { InternalDocPreviewCard } from './InternalDocPreviewCard';
import type { InternalDocPreview } from './internal-doc-preview.ts';

afterEach(cleanup);

const DAY_MS = 86_400_000;
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

const fullPreview: InternalDocPreview = {
  docName: 'guides/install',
  title: 'Install guide',
  folderPath: 'guides',
  lastEditedAt: daysAgoIso(3),
  tags: ['setup', 'onboarding'],
  backlinkCount: 2,
  excerpt: 'Install the CLI and run ok start to boot the server.',
};

function slot(container: HTMLElement, name: string): HTMLElement | null {
  return container.querySelector(`[data-slot="internal-doc-preview-${name}"]`);
}

describe('InternalDocPreviewCard — resolved doc fields', () => {
  test('renders title, folder, tags, excerpt, backlink count, and edited time', () => {
    const { container } = render(<InternalDocPreviewCard preview={fullPreview} />);
    expect(screen.getByText('Install guide')).toBeTruthy();
    expect(slot(container, 'folder')?.textContent).toContain('guides');
    expect(screen.getByText('setup')).toBeTruthy();
    expect(screen.getByText('onboarding')).toBeTruthy();
    expect(slot(container, 'excerpt')?.textContent).toContain('Install the CLI');
    const meta = slot(container, 'meta')?.textContent ?? '';
    expect(meta).toContain('2 backlinks');
    expect(meta).toContain('ago');
  });

  test('a single backlink uses the singular form', () => {
    const { container } = render(
      <InternalDocPreviewCard preview={{ ...fullPreview, backlinkCount: 1 }} />,
    );
    expect(slot(container, 'meta')?.textContent).toContain('1 backlink');
    expect(slot(container, 'meta')?.textContent).not.toContain('1 backlinks');
  });
});

describe('InternalDocPreviewCard — progressive omission', () => {
  test('omits excerpt, tags, and backlink count while their reads are unresolved', () => {
    // The reader leaves excerpt/tags/backlinkCount undefined until the local
    // reads land (or on failure); only title/folder/mtime are local-synchronous.
    const preview: InternalDocPreview = {
      docName: 'guides/install',
      title: 'Install guide',
      folderPath: 'guides',
      lastEditedAt: daysAgoIso(1),
    };
    const { container } = render(<InternalDocPreviewCard preview={preview} />);
    expect(screen.getByText('Install guide')).toBeTruthy();
    expect(slot(container, 'folder')).toBeTruthy();
    expect(slot(container, 'tags')).toBeNull();
    expect(slot(container, 'excerpt')).toBeNull();
    expect(slot(container, 'empty')).toBeNull();
    // The edited time still renders from the local mtime; the backlink chip does not.
    expect(slot(container, 'meta')?.textContent ?? '').not.toContain('backlink');
  });

  test('an empty body shows the "No excerpt" affordance, not an excerpt', () => {
    const { container } = render(
      <InternalDocPreviewCard preview={{ ...fullPreview, excerpt: '' }} />,
    );
    expect(slot(container, 'excerpt')).toBeNull();
    expect(slot(container, 'empty')?.textContent).toContain('No excerpt');
  });

  test('an empty tags array omits the tags row', () => {
    const { container } = render(<InternalDocPreviewCard preview={{ ...fullPreview, tags: [] }} />);
    expect(slot(container, 'tags')).toBeNull();
  });

  test('a root-level doc (no folder) omits the folder row', () => {
    const { container } = render(
      <InternalDocPreviewCard preview={{ ...fullPreview, folderPath: null }} />,
    );
    expect(slot(container, 'folder')).toBeNull();
    expect(screen.getByText('Install guide')).toBeTruthy();
  });
});
