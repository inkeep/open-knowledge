import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES } from '@/lib/image-attachments';
import { ReportBugImageDropzone } from './ReportBugImageDropzone';

afterEach(cleanup);

function Harness() {
  const [files, setFiles] = useState<File[]>([]);
  return (
    <>
      <ReportBugImageDropzone files={files} onChange={setFiles} disabled={false} />
      <output>{files.map((f) => f.name).join(', ')}</output>
    </>
  );
}

function drop(files: File[]) {
  fireEvent.drop(screen.getByRole('button', { name: 'Attach images' }), {
    dataTransfer: { files },
  });
}

function png(name: string) {
  return new File(['png'], name, { type: 'image/png' });
}

describe('report image drop target', () => {
  test('adds dropped images and deduplicates them without navigating', () => {
    render(<Harness />);
    drop([png('screen.png')]);
    drop([png('screen.png'), png('photo.png')]);
    expect(screen.getByText('screen.png, photo.png')).not.toBeNull();
  });

  test('rejects unsupported files, oversized batches and over-cap batches visibly', () => {
    const onChange = vi.fn();
    render(<ReportBugImageDropzone files={[]} onChange={onChange} disabled={false} />);
    drop([new File(['text'], 'note.txt', { type: 'text/plain' })]);
    expect(screen.getByText('Only PNG, JPEG, or WebP images are allowed.')).not.toBeNull();
    drop([
      new File([new Uint8Array(MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES + 1)], 'big.png', {
        type: 'image/png',
      }),
    ]);
    expect(screen.getByText('Attachments must total under 3 MB.')).not.toBeNull();
    drop([png('1.png'), png('2.png'), png('3.png'), png('4.png')]);
    expect(screen.getByText('You can attach up to 3 images.')).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    drop([png('small.png')]);
    expect(onChange).toHaveBeenCalledOnce();
    expect(screen.queryByText('You can attach up to 3 images.')).toBeNull();
  });

  test('prevents drops and browse actions while creation is in progress', async () => {
    const onChange = vi.fn();
    render(<ReportBugImageDropzone files={[]} onChange={onChange} disabled />);
    drop([png('screen.png')]);
    const picker = document.querySelector('input');
    if (picker === null) throw new Error('Missing picker');
    const click = vi.spyOn(picker, 'click');
    await userEvent.click(screen.getByRole('button', { name: 'Attach images' }));
    expect(click).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  test('keyboard activation opens the file picker', async () => {
    render(<Harness />);
    const picker = document.querySelector('input');
    if (picker === null) throw new Error('Missing picker');
    const click = vi.spyOn(picker, 'click');
    screen.getByRole('button', { name: 'Attach images' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(click).toHaveBeenCalledOnce();
  });
});
