import type { Config, ConfigBinding, ConfigPatch } from '@inkeep/open-knowledge-core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useConfigForm } from './use-config-form';

type ConfigListener = (next: Config) => void;

let subscribeListener: ConfigListener | null = null;
let unsubscribeMock = vi.fn(() => {});
let patchMock = vi.fn((_patch: ConfigPatch) => ({
  ok: true as const,
  effective: {} as Config,
  appliedPaths: ['appearance.theme'],
}));
let commitResult: boolean | null = null;

function createBinding(initial: Config): ConfigBinding {
  return {
    current: () => initial,
    subscribe: (listener: ConfigListener) => {
      subscribeListener = listener;
      return () => {
        if (subscribeListener === listener) subscribeListener = null;
        unsubscribeMock();
      };
    },
    patch: patchMock,
  } as unknown as ConfigBinding;
}

function Harness({ binding }: { binding: ConfigBinding }) {
  const { form, commitField } = useConfigForm(binding);
  return (
    <form>
      <label htmlFor="theme-input">Theme</label>
      <input id="theme-input" {...form.register('appearance.theme')} />
      <button
        type="button"
        onClick={() => {
          commitResult = commitField('appearance.theme');
        }}
      >
        Commit
      </button>
    </form>
  );
}

describe('useConfigForm runtime wiring', () => {
  beforeEach(() => {
    subscribeListener = null;
    unsubscribeMock = vi.fn(() => {});
    patchMock = vi.fn((_patch: ConfigPatch) => ({
      ok: true as const,
      effective: {} as Config,
      appliedPaths: ['appearance.theme'],
    }));
    commitResult = null;
  });

  afterEach(() => {
    cleanup();
  });

  test('seeds useForm from binding.current, subscribes to external updates, and commits through the binding', () => {
    const binding = createBinding({ appearance: { theme: 'dark' } } as Config);
    const { unmount } = render(<Harness binding={binding} />);

    const input = screen.getByLabelText('Theme') as HTMLInputElement;
    expect(input.value).toBe('dark');
    expect(subscribeListener).not.toBeNull();

    act(() => {
      subscribeListener?.({ appearance: { theme: 'light' } } as Config);
    });
    expect(input.value).toBe('light');

    fireEvent.change(input, { target: { value: 'system' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));

    expect(commitResult).toBe(true);
    expect(patchMock).toHaveBeenCalledWith({ appearance: { theme: 'system' } });

    unmount();

    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
    expect(subscribeListener).toBeNull();
  });
});
