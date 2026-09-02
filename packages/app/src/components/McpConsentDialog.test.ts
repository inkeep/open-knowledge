import { describe, expect, test, vi } from 'vitest';
import type { OkMcpWiringShowPayload } from '@/lib/desktop-bridge-types';
import { McpConsentDialog } from './McpConsentDialog';
import { connectableEditors, isPathRowActionable, type ToastImpl } from './McpConsentDialogBody';

type EditorDetection = OkMcpWiringShowPayload['detectedEditors'][number];

function ed(o: Omit<EditorDetection, 'configPath' | 'entryLocator'>): EditorDetection {
  return { configPath: null, entryLocator: 'mcpServers.open-knowledge', ...o };
}

const sampleDetection: readonly EditorDetection[] = [
  ed({ id: 'claude', label: 'Claude', detected: true, willReplace: false }),
  ed({ id: 'claude-desktop', label: 'Claude Desktop', detected: false, willReplace: false }),
  ed({ id: 'cursor', label: 'Cursor', detected: true, willReplace: false }),
  ed({ id: 'codex', label: 'Codex', detected: false, willReplace: false }),
];

describe('connectableEditors', () => {
  test('keeps detected tools in payload order and drops undetected ones', () => {
    expect(connectableEditors(sampleDetection).map((e) => e.id)).toEqual(['claude', 'cursor']);
  });

  test('empty payload yields an empty write set', () => {
    expect(connectableEditors([])).toEqual([]);
  });

  test('none detected yields an empty write set — the dialog renders no checkbox', () => {
    const out = connectableEditors([
      ed({ id: 'claude', label: 'Claude', detected: false, willReplace: false }),
      ed({ id: 'cursor', label: 'Cursor', detected: false, willReplace: false }),
    ]);
    expect(out).toEqual([]);
  });

  test('all detected yields every tool', () => {
    const out = connectableEditors([
      ed({ id: 'claude', label: 'Claude', detected: true, willReplace: false }),
      ed({ id: 'cursor', label: 'Cursor', detected: true, willReplace: false }),
    ]);
    expect(out.map((e) => e.id)).toEqual(['claude', 'cursor']);
  });
});

describe('isPathRowActionable', () => {
  test('actionable only when an rc file is touchable AND nothing is installed yet', () => {
    expect(
      isPathRowActionable({
        shellDetected: true,
        rcFilesToTouch: ['~/.zshrc'],
        alreadyInstalled: false,
      }),
    ).toBe(true);
  });

  test('hidden row (no touchable rc files) solicits no decision', () => {
    expect(
      isPathRowActionable({ shellDetected: false, rcFilesToTouch: [], alreadyInstalled: false }),
    ).toBe(false);
  });

  test('informational row (already installed / consent granted) solicits no decision', () => {
    expect(
      isPathRowActionable({
        shellDetected: true,
        rcFilesToTouch: ['~/.zshrc'],
        alreadyInstalled: true,
      }),
    ).toBe(false);
  });
});

describe('McpConsentDialog module shape', () => {
  test('exports the component + the pure write-set helpers + ToastImpl type', () => {
    expect(typeof McpConsentDialog).toBe('function');
    expect(typeof connectableEditors).toBe('function');
    expect(typeof isPathRowActionable).toBe('function');
    const toastShape: ToastImpl = { error: () => {}, message: () => {} };
    expect(typeof toastShape.error).toBe('function');
    expect(typeof toastShape.message).toBe('function');
  });

  test('ToastImpl exposes the full error + message surface the dialog injects', () => {
    const errors: string[] = [];
    const messages: string[] = [];
    const toast: ToastImpl = {
      error: (msg) => errors.push(msg),
      message: (msg) => messages.push(msg),
    };
    toast.error('boom');
    toast.message('fyi');
    expect(errors).toEqual(['boom']);
    expect(messages).toEqual(['fyi']);
  });

  test('mock module-level usage check: toast methods are invocable from a Set-like context', () => {
    const spy = vi.fn((_msg: string) => {});
    const toast: ToastImpl = { error: spy, message: vi.fn() };
    toast.error('hello');
    expect(spy.mock.calls.length).toBe(1);
    expect(spy.mock.calls[0]).toEqual(['hello']);
  });
});
