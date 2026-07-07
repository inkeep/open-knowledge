/**
 * DOM tests for `CodePreviewEditModal` — pin the load-bearing UX
 * contracts:
 *   - opens with the seeded `initialValue`
 *   - Cancel and the close button discard the draft (onSave not called)
 *   - the Save button commits the current draft via `onSave`
 *   - a fresh open re-seeds from `initialValue` (no stale-draft carryover)
 *   - the preview pane mounts only when `renderPreview` is supplied
 *
 * CodeMirror's keymap (Esc, Cmd+Enter) lives inside its own EditorView
 * and isn't reachable via DOM-fire keyboard events in jsdom (it reads
 * from KeyboardEvent.code which jsdom doesn't fully populate). Those
 * shortcuts are exercised in Playwright instead.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { CodePreviewEditModal } from './CodePreviewEditModal';

// jsdom preload exposes Element / MutationObserver but not NodeFilter; Radix's
// `react-focus-scope` (Dialog's focus trap) reads it on mount. Bridge it on
// globalThis BEFORE `render()` mounts the Dialog. Mirrors the local-bridge
// pattern other DOM tests use for jsdom globals that the shared preload
// doesn't cover.
if (typeof window !== 'undefined' && !(globalThis as { NodeFilter?: unknown }).NodeFilter) {
  (globalThis as { NodeFilter?: unknown }).NodeFilter = (
    window as unknown as { NodeFilter: unknown }
  ).NodeFilter;
}

afterEach(() => {
  // jsdom doesn't auto-cleanup between tests under Bun's test runtime; do it
  // explicitly so the next render starts from a fresh document.
  document.body.innerHTML = '';
});

/**
 * Controlled wrapper — most call sites pass `open` + `onOpenChange` as
 * a controlled pair, so the test fixture does too.
 */
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
    // No renderPreview → no preview slot.
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
    // With renderPreview → preview slot mounts. The preview consumes the
    // *debounced* draft; on first paint it sees the initialValue without
    // the debounce timer having to fire.
    const preview = await screen.findByTestId('ok-code-preview-edit-modal-preview');
    expect(preview.textContent ?? '').toContain('<p>hello</p>');
    expect(saved).toBeNull();
  });

  test('re-opening with a new initialValue re-seeds the editor', async () => {
    // Verify via Save round-trip (each open snapshots initialValue;
    // Save returns the snapshot). jsdom doesn't render CodeMirror's
    // virtual lines into queryable DOM text, so a textContent check
    // would test cm-view's rendering, not our modal's seeding contract.
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
