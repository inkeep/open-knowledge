import { act, cleanup, render } from '@testing-library/react';
import { createRef, type ReactNode, type Ref } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type PanelProps = {
  readonly id?: string;
  readonly minSize?: string;
  readonly maxSize?: string;
  readonly children?: ReactNode;
};

const panelPropsById = new Map<string, PanelProps>();
const resizeCalls: string[] = [];
const panelHandle = {
  collapse: vi.fn(),
  resize: vi.fn((size: string) => {
    resizeCalls.push(size);
  }),
};

const panelRef = { current: panelHandle };

vi.doMock('react-resizable-panels', () => ({
  usePanelRef: () => panelRef,
}));

vi.doMock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResizablePanel: (props: PanelProps) => {
    panelPropsById.set(props.id ?? 'editor-card', props);
    return <div id={props.id}>{props.children}</div>;
  },
  ResizableHandle: ({ style }: { style?: { display?: string } }) => (
    <hr data-testid="bottom-handle" data-display={style?.display ?? ''} />
  ),
}));

const { TerminalDock } = await import('./TerminalDock');
type TerminalDockHandle = import('./TerminalDock').TerminalDockHandle;

function Dock({
  editorVisible,
  visible = true,
  dockRef,
}: {
  editorVisible: boolean;
  visible?: boolean;
  dockRef?: Ref<TerminalDockHandle>;
}) {
  return (
    <TerminalDock
      ref={dockRef}
      editorVisible={editorVisible}
      placement="bottom"
      visible={visible}
      available
      variant="card"
      onVisibleChange={() => {}}
      onBottomContainer={() => {}}
    >
      <div data-testid="editor-card" />
    </TerminalDock>
  );
}

const flush = () => act(async () => {});

beforeEach(() => {
  localStorage.clear();
  panelPropsById.clear();
  resizeCalls.length = 0;
  panelHandle.resize.mockClear();
});

afterEach(() => cleanup());

describe('the bottom terminal while the editor is hidden', () => {
  test('takes the full column height and hides the divider above it', async () => {
    const view = render(<Dock editorVisible />);
    await flush();
    resizeCalls.length = 0;

    view.rerender(<Dock editorVisible={false} />);
    await flush();

    expect(resizeCalls.at(-1)).toBe('100%');
    expect(panelPropsById.get('terminal-dock-panel')?.maxSize).toBe('100%');
    expect(panelPropsById.get('editor-card')?.minSize).toBe('0%');
    expect(view.getByTestId('bottom-handle').getAttribute('data-display')).toBe('none');
  });

  test('returns to its saved height when the editor is shown again', async () => {
    const view = render(<Dock editorVisible />);
    await flush();
    const savedHeight = resizeCalls.at(-1);
    view.rerender(<Dock editorVisible={false} />);
    await flush();

    view.rerender(<Dock editorVisible />);
    await flush();

    expect(savedHeight).toMatch(/px$/);
    expect(resizeCalls.at(-1)).toBe(savedHeight);
    expect(panelPropsById.get('terminal-dock-panel')?.maxSize).toBe('95%');
    expect(panelPropsById.get('editor-card')?.minSize).toBe('5%');
    expect(view.getByTestId('bottom-handle').getAttribute('data-display')).toBe('');
  });

  test('a window resize while hidden does not shrink it back to its saved height', async () => {
    const view = render(<Dock editorVisible />);
    await flush();
    view.rerender(<Dock editorVisible={false} />);
    await flush();
    resizeCalls.length = 0;

    Object.defineProperty(window, 'innerHeight', { value: 200, configurable: true });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(resizeCalls).toEqual([]);
  });

  test('a resize that fails for an unexpected reason is reported, and one before the panel registers is not', async () => {
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    const view = render(<Dock editorVisible />);
    await flush();

    panelHandle.resize.mockImplementationOnce(() => {
      throw new Error('Group :r3: not found');
    });
    view.rerender(<Dock editorVisible={false} />);
    await flush();
    expect(warnings).toEqual([]);

    panelHandle.resize.mockImplementationOnce(() => {
      throw new Error('size out of range');
    });
    view.rerender(<Dock editorVisible />);
    await flush();
    warnSpy.mockRestore();

    expect(warnings.map((message) => JSON.parse(message))).toEqual([
      { event: 'terminal-dock-fill-resize-failed', error: 'size out of range' },
    ]);
  });

  test('bringing back a hidden-editor terminal reports an unexpected resize failure', async () => {
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    const dockRef = createRef<TerminalDockHandle>();
    render(<Dock editorVisible={false} dockRef={dockRef} />);
    await flush();

    panelHandle.resize.mockImplementationOnce(() => {
      throw new Error('size out of range');
    });
    act(() => dockRef.current?.bringBackBottom());
    warnSpy.mockRestore();

    expect(panelHandle.resize).toHaveBeenLastCalledWith('100%');
    expect(warnings.map((message) => JSON.parse(message))).toEqual([
      { event: 'terminal-dock-bring-back-failed', error: 'size out of range' },
    ]);
  });

  test('a hidden terminal is not resized when the editor hides', async () => {
    const view = render(<Dock editorVisible visible={false} />);
    await flush();
    resizeCalls.length = 0;

    view.rerender(<Dock editorVisible={false} visible={false} />);
    await flush();

    expect(resizeCalls).toEqual([]);
  });
});
