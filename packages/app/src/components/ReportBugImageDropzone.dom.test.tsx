import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { makeFilesDataTransfer } from '@/editor/composer-drop.test-helper';
import { MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES } from '@/lib/image-attachments';
import { ReportBugImageDropzone } from './ReportBugImageDropzone';

afterEach(cleanup);

function Harness({ disabled = false }: { disabled?: boolean }) {
  const [files, setFiles] = useState<File[]>([]);
  return (
    <>
      <textarea aria-label="What happened?" />
      <ReportBugImageDropzone files={files} onChange={setFiles} disabled={disabled} />
      <output>{files.map((f) => f.name).join(', ')}</output>
    </>
  );
}

function drop(files: File[]) {
  fireEvent.drop(screen.getByRole('button', { name: 'Attach images' }), {
    dataTransfer: { files },
  });
}

function paste(target: Element, clipboardData: object) {
  const event = createEvent.paste(target, { clipboardData });
  fireEvent(target, event);
  return event;
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

  test('adds pasted clipboard images wherever focus is in the dialog', () => {
    render(<Harness />);
    const note = screen.getByRole('textbox', { name: 'What happened?' });
    const fromNote = paste(note, makeFilesDataTransfer([png('image.png')]));
    expect(fromNote.defaultPrevented).toBe(true);
    paste(
      screen.getByRole('button', { name: 'Attach images' }),
      makeFilesDataTransfer([png('second.png')]),
    );
    paste(document.body, makeFilesDataTransfer([png('third.png')]));
    expect(screen.getByText('image.png, second.png, third.png')).not.toBeNull();
  });

  test('keeps two different pasted screenshots that share the clipboard name', () => {
    render(<Harness />);
    const note = screen.getByRole('textbox', { name: 'What happened?' });
    paste(note, makeFilesDataTransfer([png('image.png')]));
    paste(
      note,
      makeFilesDataTransfer([new File(['bigger png'], 'image.png', { type: 'image/png' })]),
    );
    expect(screen.getByText('image.png, image.png')).not.toBeNull();
  });

  test('ignores pasted images while a dialog stacked above the report has focus', () => {
    function Stacked() {
      const [files, setFiles] = useState<File[]>([]);
      return (
        <>
          <div role="dialog" aria-label="Report a bug">
            <ReportBugImageDropzone files={files} onChange={setFiles} disabled={false} />
            <output>{files.map((f) => f.name).join(', ')}</output>
          </div>
          <div role="dialog" aria-label="Screenshot preview">
            <button type="button">Close</button>
          </div>
        </>
      );
    }
    render(<Stacked />);
    const event = paste(
      screen.getByRole('button', { name: 'Close' }),
      makeFilesDataTransfer([png('image.png')]),
    );
    expect(event.defaultPrevented).toBe(false);
    paste(
      screen.getByRole('button', { name: 'Attach images' }),
      makeFilesDataTransfer([png('screen.png')]),
    );
    expect(document.querySelector('output')?.textContent).toBe('screen.png');
  });

  test('leaves text pastes alone and reports pasted images it cannot attach', () => {
    render(<Harness />);
    const note = screen.getByRole('textbox', { name: 'What happened?' });
    const text = paste(note, { types: ['text/plain'], files: [], items: [], getData: () => 'hi' });
    expect(text.defaultPrevented).toBe(false);
    paste(note, makeFilesDataTransfer([new File(['gif'], 'image.gif', { type: 'image/gif' })]));
    expect(screen.getByText('Only PNG, JPEG, or WebP images are allowed.')).not.toBeNull();
  });

  test('ignores pasted images while creation is in progress', () => {
    render(<Harness disabled />);
    const event = paste(document.body, makeFilesDataTransfer([png('image.png')]));
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByText('image.png')).toBeNull();
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
