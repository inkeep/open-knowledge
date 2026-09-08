import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useComposerAttachments } from '@/editor/use-composer-attachments';
import { MAX_TOTAL_ATTACHMENT_BYTES } from '@/lib/acp/image-attachment';

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47];
const PNG_BASE64 = btoa(String.fromCharCode(...PNG_BYTES));

function pngFile(name: string) {
  return new File([new Uint8Array(PNG_BYTES)], name, { type: 'image/png' });
}

function renderAttachments(onError: (message: string) => void = () => {}) {
  return renderHook(() => useComposerAttachments({ onError }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useComposerAttachments', () => {
  test('an allowed image becomes a pending attachment with its bytes base64-encoded', async () => {
    const onError = vi.fn();
    const { result } = renderAttachments(onError);

    await act(async () => {
      await result.current.ingestFiles([pngFile('shot.png')]);
    });

    await waitFor(() => {
      expect(result.current.pendingAttachments).toHaveLength(1);
    });
    expect(result.current.pendingAttachments[0]).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
      data: PNG_BASE64,
      name: 'shot.png',
    });
    expect(onError).not.toHaveBeenCalled();
  });

  test('a disallowed image type is reported through onError and never attaches', async () => {
    const onError = vi.fn();
    const { result } = renderAttachments(onError);

    await act(async () => {
      await result.current.ingestFiles([
        new File([new Uint8Array(PNG_BYTES)], 'scan.tiff', { type: 'image/tiff' }),
      ]);
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toContain('image/tiff');
    expect(result.current.pendingAttachments).toEqual([]);
  });

  test('a non-image file with no path resolver is reported, not silently dropped', async () => {
    const onError = vi.fn();
    const { result } = renderAttachments(onError);

    await act(async () => {
      await result.current.ingestFiles([new File(['notes'], 'notes.txt', { type: 'text/plain' })]);
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toContain("can't attach files by path");
    expect(result.current.pendingAttachments).toEqual([]);
  });

  test('a batch of unattachable files is reported once, not once per file', async () => {
    const onError = vi.fn();
    const { result } = renderAttachments(onError);

    await act(async () => {
      await result.current.ingestFiles([
        new File(['a'], 'a.txt', { type: 'text/plain' }),
        new File(['b'], 'b.txt', { type: 'text/plain' }),
        new File(['c'], 'c.txt', { type: 'text/plain' }),
      ]);
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toContain('3');
    expect(result.current.pendingAttachments).toEqual([]);
  });

  test('attachments past the per-message byte budget are refused instead of oversizing the frame', async () => {
    const onError = vi.fn();
    const { result } = renderAttachments(onError);
    const halfBudget = new File(
      [new Uint8Array(Math.ceil(MAX_TOTAL_ATTACHMENT_BYTES * 0.6))],
      'big.png',
      {
        type: 'image/png',
      },
    );
    const second = new File(
      [new Uint8Array(Math.ceil(MAX_TOTAL_ATTACHMENT_BYTES * 0.6))],
      'big2.png',
      {
        type: 'image/png',
      },
    );

    await act(async () => {
      await result.current.ingestFiles([halfBudget, second]);
    });

    await waitFor(() => {
      expect(result.current.pendingAttachments).toHaveLength(1);
    });
    expect(result.current.pendingAttachments[0]).toMatchObject({ name: 'big.png' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toContain(
      `${Math.round(MAX_TOTAL_ATTACHMENT_BYTES / 1024)} KB`,
    );
  });

  test('an in-flight read shows a placeholder that clears once the attachment lands', async () => {
    const { result } = renderAttachments();

    let settled: Promise<void> | undefined;
    act(() => {
      settled = result.current.ingestFiles([pngFile('slow.png')]);
    });
    expect(result.current.pendingUploads).toHaveLength(1);
    expect(result.current.pendingUploads[0]).toMatchObject({ name: 'slow.png' });

    await act(async () => {
      await settled;
    });
    expect(result.current.pendingUploads).toEqual([]);
    expect(result.current.pendingAttachments).toHaveLength(1);
  });

  test('clearing mid-ingest keeps a late-resolving read from resurrecting the attachment', async () => {
    const { result } = renderAttachments();

    let settled: Promise<void> | undefined;
    act(() => {
      settled = result.current.ingestFiles([pngFile('late.png')]);
    });
    expect(result.current.pendingUploads).toHaveLength(1);

    act(() => {
      result.current.clear();
    });
    expect(result.current.pendingUploads).toEqual([]);
    expect(result.current.pendingAttachments).toEqual([]);

    await act(async () => {
      await settled;
    });
    expect(result.current.pendingAttachments).toEqual([]);
    expect(result.current.pendingUploads).toEqual([]);
  });

  test('a batch abandoned by clear() reports nothing for the files it threw away', async () => {
    const onError = vi.fn();
    const { result } = renderAttachments(onError);

    let settled: Promise<void> | undefined;
    act(() => {
      settled = result.current.ingestFiles([
        new File(['notes'], 'notes.txt', { type: 'text/plain' }),
      ]);
    });

    act(() => {
      result.current.clear();
    });

    await act(async () => {
      await settled;
    });
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.pendingAttachments).toEqual([]);
  });

  test('a non-image workspace file attaches as a path reference', async () => {
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useComposerAttachments({
        onError,
        absPathOf: () => '/tmp/project/notes/readme.md',
        workspaceContentDir: '/tmp/project',
        pathSeparator: '/',
      }),
    );

    await act(async () => {
      await result.current.ingestFiles([
        new File(['hello'], 'readme.md', { type: 'text/markdown' }),
      ]);
    });

    expect(result.current.pendingAttachments).toEqual([
      { kind: 'file', path: 'notes/readme.md', name: 'readme.md' },
    ]);
    expect(onError).not.toHaveBeenCalled();
  });

  test('a file whose bytes cannot be read is reported and skipped', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    const { result } = renderAttachments(onError);
    const unreadable = { name: 'broken.png', type: 'image/png', size: 4 } as unknown as File;

    await act(async () => {
      await result.current.ingestFiles([unreadable, pngFile('after.png')]);
    });

    await waitFor(() => {
      expect(result.current.pendingAttachments).toHaveLength(1);
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toContain('broken.png');
    expect(result.current.pendingAttachments[0]).toMatchObject({ name: 'after.png' });
  });

  test('removeAt removes only the addressed attachment and clear empties the strip', async () => {
    const { result } = renderAttachments();

    await act(async () => {
      await result.current.ingestFiles([pngFile('first.png'), pngFile('second.png')]);
    });
    await waitFor(() => {
      expect(result.current.pendingAttachments).toHaveLength(2);
    });

    act(() => {
      result.current.removeAt(0);
    });
    expect(result.current.pendingAttachments).toHaveLength(1);
    expect(result.current.pendingAttachments[0]).toMatchObject({ name: 'second.png' });

    act(() => {
      result.current.clear();
    });
    expect(result.current.pendingAttachments).toEqual([]);
  });
});
