import { EditorView } from '@codemirror/view';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { CodePreviewEditModal } from './CodePreviewEditModal';

if (typeof window !== 'undefined' && !(globalThis as { NodeFilter?: unknown }).NodeFilter) {
  (globalThis as { NodeFilter?: unknown }).NodeFilter = (
    window as unknown as { NodeFilter: unknown }
  ).NodeFilter;
}

if (typeof window !== 'undefined' && !(globalThis as { Window?: unknown }).Window) {
  (globalThis as { Window?: unknown }).Window = (window as unknown as { Window: unknown }).Window;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function Harness(props: {
  initialValue?: string;
  renderPreview?: (value: string, setValue: (value: string) => void) => React.ReactNode;
  onSave: (value: string) => void;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(props.initialOpen ?? true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        re-open
      </button>
      <CodePreviewEditModal
        open={open}
        onOpenChange={setOpen}
        initialValue={props.initialValue ?? '<p>hello</p>'}
        language="html"
        title="Edit HTML preview"
        onSave={props.onSave}
        renderPreview={props.renderPreview}
      />
    </>
  );
}

describe('CodePreviewEditModal', () => {
  test('Cancel discards the draft (onSave not called)', async () => {
    let saveCount = 0;
    render(
      <Harness
        onSave={() => {
          saveCount += 1;
        }}
      />,
    );
    const cancel = await screen.findByRole('button', { name: /cancel/i });
    fireEvent.click(cancel);
    await waitFor(() => {
      expect(screen.queryByTestId('ok-code-preview-edit-modal-body')).toBeNull();
    });
    expect(saveCount).toBe(0);
  });

  test('default helper copy renders shortcut keys as shared kbd chips', async () => {
    render(<Harness onSave={() => {}} />);
    await screen.findByTestId('ok-code-preview-edit-modal-source');

    const shortcutKeys = Array.from(document.querySelectorAll('[data-slot="kbd"]')).map(
      (node) => node.textContent,
    );
    expect(shortcutKeys).toEqual(['Cmd/Ctrl+Enter', 'Esc']);
  });

  test('Save commits the current draft via onSave', async () => {
    let saved: string | null = null;
    render(
      <Harness
        onSave={(v) => {
          saved = v;
        }}
      />,
    );
    await screen.findByTestId('ok-code-preview-edit-modal-source');
    const saveBtn = await screen.findByRole('button', { name: /save/i });
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(saved).toBe('<p>hello</p>');
    });
  });

  test('preview pane renders only when renderPreview is supplied', async () => {
    let saved: string | null = null;
    const { unmount } = render(
      <Harness
        onSave={(v) => {
          saved = v;
        }}
      />,
    );
    expect(screen.queryByTestId('ok-code-preview-edit-modal-preview')).toBeNull();
    unmount();

    render(
      <Harness
        onSave={(v) => {
          saved = v;
        }}
        renderPreview={(value) => <div data-testid="preview-marker">{value}</div>}
      />,
    );
    const preview = await screen.findByTestId('ok-code-preview-edit-modal-preview');
    expect(preview.textContent ?? '').toContain('<p>hello</p>');
    expect(saved).toBeNull();
  });

  test('body opts into md:flex-row-reverse so the preview renders visually left in wide viewports', async () => {
    render(
      <Harness
        onSave={() => {}}
        renderPreview={(value) => <div data-testid="preview-marker">{value}</div>}
      />,
    );
    const body = await screen.findByTestId('ok-code-preview-edit-modal-body');
    expect(body.className).toContain('md:flex-row-reverse');
    expect(body.className).toContain('overflow-y-auto');
    expect(body.className).toContain('overscroll-contain');
  });

  test('body drops the row-reverse token when the preview pane is absent', async () => {
    render(<Harness onSave={() => {}} />);
    const body = await screen.findByTestId('ok-code-preview-edit-modal-body');
    expect(body.className).not.toContain('md:flex-row-reverse');
    expect(body.className).not.toContain('md:flex-row');
  });

  test('preview-originated edits write back into the draft and commit on Save', async () => {
    let saved: string | null = null;
    render(
      <Harness
        onSave={(v) => {
          saved = v;
        }}
        renderPreview={(value, setValue) => (
          <div>
            <div data-testid="preview-value">{value}</div>
            <button type="button" onClick={() => setValue('<p>from-canvas</p>')}>
              preview-edit
            </button>
          </div>
        )}
      />,
    );
    const btn = await screen.findByRole('button', { name: 'preview-edit' });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(screen.getByTestId('preview-value').textContent).toBe('<p>from-canvas</p>');
    });
    const save = screen.getByRole('button', { name: /save/i });
    fireEvent.click(save);
    await waitFor(() => {
      expect(saved).toBe('<p>from-canvas</p>');
    });
  });

  test('Cancel after a preview-originated edit still discards (onSave not called)', async () => {
    let saved: string | null = null;
    render(
      <Harness
        onSave={(v) => {
          saved = v;
        }}
        renderPreview={(_value, setValue) => (
          <button type="button" onClick={() => setValue('<p>canvas-edit</p>')}>
            preview-edit
          </button>
        )}
      />,
    );
    const btn = await screen.findByRole('button', { name: 'preview-edit' });
    await act(async () => {
      fireEvent.click(btn);
    });
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('ok-code-preview-edit-modal-body')).toBeNull();
    });
    expect(saved).toBeNull();
  });

  test('re-opening with a new initialValue re-seeds the editor', async () => {
    const saved: string[] = [];
    function ReSeedHarness() {
      const [open, setOpen] = useState(true);
      const [version, setVersion] = useState(0);
      const initial = version === 0 ? '<h1>first</h1>' : '<h1>second</h1>';
      return (
        <>
          <button
            type="button"
            data-testid="bump"
            onClick={() => {
              setVersion(1);
              setOpen(true);
            }}
          >
            bump
          </button>
          <CodePreviewEditModal
            open={open}
            onOpenChange={setOpen}
            initialValue={initial}
            language="html"
            title="Edit"
            onSave={(v) => {
              saved.push(v);
            }}
          />
        </>
      );
    }
    render(<ReSeedHarness />);
    await screen.findByTestId('ok-code-preview-edit-modal-source');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(saved).toEqual(['<h1>first</h1>']);
    });
    fireEvent.click(screen.getByTestId('bump'));
    await screen.findByTestId('ok-code-preview-edit-modal-source');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => {
      expect(saved).toEqual(['<h1>first</h1>', '<h1>second</h1>']);
    });
  });

  test('Cmd/Ctrl+Enter commits the draft via onSave and closes the modal', async () => {
    let saved: string | null = null;
    render(
      <Harness
        initialValue="graph TD; A-->B"
        onSave={(v) => {
          saved = v;
        }}
      />,
    );
    const host = await screen.findByTestId('ok-code-preview-edit-modal-source');
    await waitFor(() => {
      expect(host.querySelector('.cm-content')).toBeTruthy();
    });
    const content = host.querySelector<HTMLElement>('.cm-content');
    if (!content) throw new Error('CodeMirror content never mounted');
    expect(EditorView.findFromDOM(content)).toBeTruthy();

    const modProps = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
    await act(async () => {
      content.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true,
          cancelable: true,
          ...modProps,
        }),
      );
    });

    await waitFor(() => {
      expect(saved).toBe('graph TD; A-->B');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('ok-code-preview-edit-modal-body')).toBeNull();
    });
  });
});
