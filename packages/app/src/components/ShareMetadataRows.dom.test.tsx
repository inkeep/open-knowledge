/**
 * RTL behavioral tests for `ShareMetadataRows`.
 *
 * The metadata rows shown in the share-receive dialog header are kind-aware:
 * a `doc` share renders a "File" label row, a `folder` share renders a
 * "Folder" label row, and a content-root folder share (empty path — the
 * empty-string sentinel from `ShareConstructUrlRequestSchema`'s folder
 * variant) suppresses the target row entirely. These tests render the
 * component directly (test-only export) and assert the rendered DOM:
 *
 *   - doc target           → "File" label + path value present
 *   - folder target        → "Folder" label + path value present
 *   - content-root folder  → NEITHER File nor Folder row (target row absent),
 *                            while a non-content-root folder still renders its
 *                            row (pins the `showTargetRow` suppression boolean)
 *
 * `<Trans>` renders its literal children text when no I18nProvider is mounted
 * (the macro's source-message fallback), so the label assertions work without
 * an explicit provider — same approach the sibling CloneDialog DOM test uses.
 *
 * Substrate: jsdom via `bun run test:dom`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render, screen, within } from '@testing-library/react';
import { ShareMetadataRows } from '@/components/share-metadata-rows';

describe('ShareMetadataRows', () => {
  afterEach(() => {
    cleanup();
  });

  test('doc target renders a File label row with the path value', () => {
    render(
      <ShareMetadataRows
        owner="acme"
        repo="kb"
        path="guides/notes.md"
        kind="doc"
        branch="main"
        testId="share-receive-metadata"
        branchTestId="share-receive-metadata-branch"
      />,
    );

    expect(screen.getByText('File')).not.toBeNull();
    expect(screen.queryByText('Folder')).toBeNull();
    expect(screen.getByTestId('share-receive-metadata-target').textContent).toBe('guides/notes.md');
  });

  test('folder target (non-empty path) renders a Folder label row with the path value', () => {
    render(
      <ShareMetadataRows
        owner="acme"
        repo="kb"
        path="guides"
        kind="folder"
        branch="main"
        testId="share-receive-metadata"
        branchTestId="share-receive-metadata-branch"
      />,
    );

    expect(screen.getByText('Folder')).not.toBeNull();
    expect(screen.queryByText('File')).toBeNull();
    expect(screen.getByTestId('share-receive-metadata-target').textContent).toBe('guides');
  });

  test('content-root folder share (empty path) suppresses the target row entirely', () => {
    render(
      <ShareMetadataRows
        owner="acme"
        repo="kb"
        path=""
        kind="folder"
        branch="main"
        testId="share-receive-metadata"
        branchTestId="share-receive-metadata-branch"
      />,
    );

    // Neither a File nor a Folder label, and no target value row at all.
    expect(screen.queryByText('File')).toBeNull();
    expect(screen.queryByText('Folder')).toBeNull();
    expect(screen.queryByTestId('share-receive-metadata-target')).toBeNull();
    // The Repository row still renders — only the target row is suppressed.
    expect(screen.getByText('Repository')).not.toBeNull();
  });

  test('non-content-root folder still renders its target row (pins the suppression boolean)', () => {
    const { container } = render(
      <ShareMetadataRows
        owner="acme"
        repo="kb"
        path="docs/onboarding"
        kind="folder"
        branch="main"
        testId="share-receive-metadata"
        branchTestId="share-receive-metadata-branch"
      />,
    );

    const metadata = within(container).getByTestId('share-receive-metadata');
    expect(within(metadata).getByText('Folder')).not.toBeNull();
    expect(within(metadata).getByTestId('share-receive-metadata-target').textContent).toBe(
      'docs/onboarding',
    );
  });
});
