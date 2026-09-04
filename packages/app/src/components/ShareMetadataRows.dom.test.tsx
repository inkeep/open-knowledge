import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
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

    expect(screen.queryByText('File')).toBeNull();
    expect(screen.queryByText('Folder')).toBeNull();
    expect(screen.queryByTestId('share-receive-metadata-target')).toBeNull();
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
