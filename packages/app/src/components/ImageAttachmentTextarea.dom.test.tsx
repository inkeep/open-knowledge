import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ImageAttachmentTextarea, useImageAttachmentIntake } from '@/components/ImageAttachments';
import { TooltipProvider } from '@/components/ui/tooltip';
import { makeFilesDataTransfer } from '@/editor/composer-drop.test-helper';
import { MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES } from '@/lib/image-attachments';

afterEach(cleanup);

function Harness({
  disabled = false,
  onChange,
}: {
  disabled?: boolean;
  onChange?: (files: File[]) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [note, setNote] = useState('');
  const change = (next: File[]) => {
    onChange?.(next);
    setFiles(next);
  };
  const intake = useImageAttachmentIntake({ files, onChange: change, disabled });
  return (
    <TooltipProvider>
      <div onPaste={intake.onPaste}>
        <ImageAttachmentTextarea
          aria-label="What happened?"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          intake={intake}
        />
        <button type="button">Other control</button>
        <p data-testid="attached">{files.map((f) => f.name).join(', ')}</p>
        {createPortal(<button type="button">Close preview</button>, document.body)}
      </div>
    </TooltipProvider>
  );
}

const note = () => screen.getByRole('textbox', { name: 'What happened?' });
const attached = () => screen.getByTestId('attached').textContent;

function drop(files: File[], target: Element = note()) {
  const event = createEvent.drop(target, { dataTransfer: makeFilesDataTransfer(files) });
  fireEvent(target, event);
  return event;
}

function paste(target: Element, clipboardData: object) {
  const event = createEvent.paste(target, { clipboardData });
  fireEvent(target, event);
  return event;
}

function pick(files: File[]) {
  const input = document.querySelector('input[type="file"]');
  if (input === null) throw new Error('Missing picker');
  fireEvent.change(input, { target: { files } });
}

function png(name: string, body = 'png') {
  return new File([body], name, { type: 'image/png' });
}

describe('image attachment text box', () => {
  test('tells people they can drop, paste, or attach, and ties that hint to the box', () => {
    render(<Harness />);
    const hint = screen.getByText('Drop, paste, or attach up to 3 images.');
    expect(note().getAttribute('aria-describedby')).toContain(hint.id);
  });

  test('attaches images dropped on the text box and deduplicates them', () => {
    render(<Harness />);
    drop([png('screen.png')]);
    drop([png('screen.png'), png('photo.png')]);
    expect(attached()).toBe('screen.png, photo.png');
  });

  test('an image dropped on the attach button in the box corner attaches too', () => {
    render(<Harness />);
    drop([png('corner.png')], screen.getByRole('button', { name: 'Attach images' }));
    expect(attached()).toBe('corner.png');
  });

  test('leaves dragged text alone so it drops into the box natively', () => {
    render(<Harness />);
    const dataTransfer = { types: ['text/plain'], files: [], items: [], getData: () => 'hi' };
    const over = createEvent.dragOver(note(), { dataTransfer });
    fireEvent(note(), over);
    const dropped = createEvent.drop(note(), { dataTransfer });
    fireEvent(note(), dropped);
    expect(over.defaultPrevented).toBe(false);
    expect(dropped.defaultPrevented).toBe(false);
    expect(attached()).toBe('');
  });

  test('rejects unsupported files, oversized batches and over-cap batches visibly', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    drop([new File(['text'], 'note.txt', { type: 'text/plain' })]);
    expect(screen.getByRole('alert').textContent).toBe(
      'No images added. Only PNG, JPEG, or WebP images are allowed.',
    );
    drop([
      new File([new Uint8Array(MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES + 1)], 'big.png', {
        type: 'image/png',
      }),
    ]);
    expect(screen.getByRole('alert').textContent).toBe(
      'No images added. Attachments must total under 3 MB.',
    );
    drop([png('1.png'), png('2.png'), png('3.png'), png('4.png')]);
    expect(screen.getByRole('alert').textContent).toBe(
      'No images added. You can attach up to 3 images.',
    );
    expect(onChange).not.toHaveBeenCalled();
    drop([png('small.png')]);
    expect(onChange).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('attaches pasted images wherever focus is inside the form', () => {
    render(<Harness />);
    const fromNote = paste(note(), makeFilesDataTransfer([png('image.png')]));
    expect(fromNote.defaultPrevented).toBe(true);
    paste(
      screen.getByRole('button', { name: 'Other control' }),
      makeFilesDataTransfer([png('second.png')]),
    );
    expect(attached()).toBe('image.png, second.png');
  });

  test('keeps two different pasted screenshots that share the clipboard name', () => {
    render(<Harness />);
    paste(note(), makeFilesDataTransfer([png('image.png')]));
    paste(note(), makeFilesDataTransfer([png('image.png', 'bigger png')]));
    expect(attached()).toBe('image.png, image.png');
  });

  test('announces how many images are attached', () => {
    render(<Harness />);
    paste(note(), makeFilesDataTransfer([png('image.png')]));
    expect(screen.getByText('1 image attached')).not.toBeNull();
    paste(note(), makeFilesDataTransfer([png('second.png')]));
    expect(screen.getByText('2 images attached')).not.toBeNull();
  });

  test('ignores pasted images from content portaled out of the form, like a stacked dialog', () => {
    render(<Harness />);
    const event = paste(
      screen.getByRole('button', { name: 'Close preview' }),
      makeFilesDataTransfer([png('image.png')]),
    );
    expect(event.defaultPrevented).toBe(false);
    expect(attached()).toBe('');
  });

  test('leaves text pastes alone and says why a pasted image was not attached', () => {
    render(<Harness />);
    const text = paste(note(), {
      types: ['text/plain'],
      files: [],
      items: [],
      getData: () => 'hi',
    });
    expect(text.defaultPrevented).toBe(false);
    paste(note(), makeFilesDataTransfer([new File(['gif'], 'image.gif', { type: 'image/gif' })]));
    expect(screen.getByRole('alert').textContent).toBe(
      'No images added. Only PNG, JPEG, or WebP images are allowed.',
    );
  });

  test('browsing attaches through the same checks as paste and drop', () => {
    render(<Harness />);
    pick([new File(['gif'], 'image.gif', { type: 'image/gif' })]);
    expect(screen.getByRole('alert').textContent).toBe(
      'No images added. Only PNG, JPEG, or WebP images are allowed.',
    );
    pick([png('picked.png')]);
    expect(attached()).toBe('picked.png');
  });

  test('the attach button opens the file picker', async () => {
    render(<Harness />);
    const input = document.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('Missing picker');
    const click = vi.spyOn(input, 'click');
    await userEvent.click(screen.getByRole('button', { name: 'Attach images' }));
    expect(click).toHaveBeenCalledOnce();
  });

  test('ignores pastes, drops and browsing while disabled', () => {
    const onChange = vi.fn();
    render(<Harness disabled onChange={onChange} />);
    const event = paste(note(), makeFilesDataTransfer([png('image.png')]));
    expect(event.defaultPrevented).toBe(false);
    drop([png('screen.png')]);
    expect(screen.getByRole('button', { name: 'Attach images' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(attached()).toBe('');
  });
});
