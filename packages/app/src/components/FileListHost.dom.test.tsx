import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, expect, test } from 'vitest';
import { FileListHostProvider, useAttachFileListHost, useFileListHost } from './FileListHost';

let fileListMounts = 0;
let fileListUnmounts = 0;

afterEach(() => {
  cleanup();
  fileListMounts = 0;
  fileListUnmounts = 0;
});

function CountingFileList() {
  const [expandedFolder] = useState(() => `folder-${fileListMounts}`);
  useEffect(() => {
    fileListMounts += 1;
    return () => {
      fileListUnmounts += 1;
    };
  }, []);
  return <nav data-testid="file-list" data-expanded-folder={expandedFolder} />;
}

function EditorCardSlot() {
  const host = useFileListHost();
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  useAttachFileListHost(host, slot);
  if (host == null) return null;
  return <div data-testid="file-list-slot" ref={setSlot} />;
}

function Shell({ enabled = true, cardMounted = true }) {
  return (
    <FileListHostProvider enabled={enabled} fileList={<CountingFileList />}>
      {cardMounted ? <EditorCardSlot /> : <div data-testid="skeleton" />}
    </FileListHostProvider>
  );
}

test('draws the file list inside the editor card slot', () => {
  render(<Shell />);

  const slot = screen.getByTestId('file-list-slot');
  expect(slot.contains(screen.getByTestId('file-list'))).toBe(true);
  expect(fileListMounts).toBe(1);
});

test('keeps the file list mounted, with its state, while the slot is gone and after it returns', () => {
  const { rerender } = render(<Shell />);
  const fileList = screen.getByTestId('file-list');

  rerender(<Shell cardMounted={false} />);
  expect(screen.queryByTestId('file-list-slot')).toBeNull();
  expect(fileListMounts).toBe(1);
  expect(fileListUnmounts).toBe(0);

  rerender(<Shell />);
  expect(screen.getByTestId('file-list-slot').contains(fileList)).toBe(true);
  expect(screen.getByTestId('file-list')).toBe(fileList);
  expect(fileList.getAttribute('data-expanded-folder')).toBe('folder-0');
  expect(fileListMounts).toBe(1);
  expect(fileListUnmounts).toBe(0);
});

test('mounts the file list before any slot exists, so its listeners run from the first render', () => {
  render(<Shell cardMounted={false} />);

  expect(fileListMounts).toBe(1);
  expect(screen.queryByTestId('file-list')).toBeNull();
});

test('renders no file list and no slot when the window has none', () => {
  render(<Shell enabled={false} />);

  expect(screen.queryByTestId('file-list-slot')).toBeNull();
  expect(screen.queryByTestId('file-list')).toBeNull();
  expect(fileListMounts).toBe(0);
});

test('moving to a new slot carries the same file list element across', () => {
  function TwoSlots({ second }: { second: boolean }) {
    return (
      <FileListHostProvider enabled fileList={<CountingFileList />}>
        {second ? (
          <section data-testid="second">
            <EditorCardSlot />
          </section>
        ) : (
          <section data-testid="first">
            <EditorCardSlot />
          </section>
        )}
      </FileListHostProvider>
    );
  }
  const { rerender } = render(<TwoSlots second={false} />);
  const fileList = screen.getByTestId('file-list');

  act(() => {
    rerender(<TwoSlots second />);
  });

  expect(screen.getByTestId('second').contains(fileList)).toBe(true);
  expect(fileListMounts).toBe(1);
});
