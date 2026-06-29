
import { afterEach, describe, expect, test } from 'bun:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { CodePreviewEditModal } from './CodePreviewEditModal';

if (typeof window !== 'undefined' && !(globalThis as { NodeFilter?: unknown }).NodeFilter) {
  (globalThis as { NodeFilter?: unknown }).NodeFilter = (
    window as unknown as { NodeFilter: unknown }
  ).NodeFilter;
}

afterEach(() => {
  document.body.innerHTML = '';
});

function Harness(props: {
  initialValue?: string;
  renderPreview?: (value: string) => React.ReactNode;
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
    expect(shortcutKeys).toEqual(['⌘ Enter', 'Esc']);
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
});
