import { cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { makeFilesDataTransfer } from '@/editor/composer-drop.test-helper';
import { FeedbackForm } from './FeedbackForm';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderForm() {
  render(
    <TooltipProvider>
      <textarea aria-label="Editor" />
      <FeedbackForm source="test" />
    </TooltipProvider>,
  );
  return screen.getByPlaceholderText('Tell us more (optional)');
}

function paste(target: Element, clipboardData: object) {
  const event = createEvent.paste(target, { clipboardData });
  fireEvent(target, event);
  return event;
}

function png(name: string, body = 'png') {
  return new File([body], name, { type: 'image/png' });
}

describe('feedback form image intake', () => {
  test('attaches an image pasted into the message and announces it', async () => {
    const message = renderForm();
    const event = paste(message, makeFilesDataTransfer([png('image.png')]));
    expect(event.defaultPrevented).toBe(true);
    expect(await screen.findByText('image.png')).not.toBeNull();
    expect(screen.getByText('1 image attached')).not.toBeNull();
  });

  test('leaves image pastes outside the form, such as in the editor, alone', () => {
    renderForm();
    const event = paste(
      screen.getByRole('textbox', { name: 'Editor' }),
      makeFilesDataTransfer([png('image.png')]),
    );
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByText('image.png')).toBeNull();
  });

  test('leaves text pastes into the message alone', () => {
    const message = renderForm();
    const event = paste(message, {
      types: ['text/plain'],
      files: [],
      items: [],
      getData: () => 'hi',
    });
    expect(event.defaultPrevented).toBe(false);
  });

  test('attaches an image dropped on the message box', async () => {
    const message = renderForm();
    const dataTransfer = makeFilesDataTransfer([png('dropped.png')]);
    fireEvent.dragOver(message, { dataTransfer });
    fireEvent.drop(message, { dataTransfer });
    expect(await screen.findByText('dropped.png')).not.toBeNull();
  });

  test('says why a pasted image was not attached', async () => {
    const message = renderForm();
    paste(message, makeFilesDataTransfer([new File(['gif'], 'image.gif', { type: 'image/gif' })]));
    expect(await screen.findByText('Only PNG, JPEG, or WebP images are allowed.')).not.toBeNull();
    expect(screen.queryByText('image.gif')).toBeNull();
  });

  test('keeps two different pasted screenshots that share the clipboard name', async () => {
    const message = renderForm();
    paste(message, makeFilesDataTransfer([png('image.png')]));
    paste(message, makeFilesDataTransfer([png('image.png', 'bigger png')]));
    await waitFor(() => expect(screen.getAllByText('image.png')).toHaveLength(2));
    expect(screen.getByText('2 images attached')).not.toBeNull();
  });

  test('ignores image pastes while the feedback is being sent', async () => {
    vi.stubGlobal('fetch', () => new Promise(() => {}));
    const message = renderForm();
    fireEvent.click(screen.getByRole('radio', { name: 'Good' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByRole('button', { name: 'Sending' });
    const event = paste(message, makeFilesDataTransfer([png('image.png')]));
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByText('image.png')).toBeNull();
  });

  test('tells people they can drop, paste, or attach images', () => {
    renderForm();
    expect(screen.getByText('Drop, paste, or attach up to 3 images.')).not.toBeNull();
  });
});
