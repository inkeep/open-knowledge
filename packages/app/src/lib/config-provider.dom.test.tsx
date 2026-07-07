/**
 * Tier-3 RTL mount tests for ConfigProvider Context propagation —
 * sibling to the structural-grep `config-provider.test.tsx`. Exercises `render` + the
 * React Context API surface under the jsdom substrate (precedent #43);
 * invocation via `bun run test:dom`.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';

// `mock.module(...)` is module-level and is NOT reset by Bun's `mock.restore()`
// — it persists for the lifetime of this file. Both `describe` blocks below
// share the mocked `useThemeBridge` surface. That's intentional here because
// every test in this file exercises the `collabUrl: null` cold-start path (the
// prop is passed as null below) where the real provider early-returns before
// any Hocuspocus / binding / theme-bridge interaction. If a future Tier-3 test
// needs to exercise the REAL seam (e.g. asserting that ConfigProvider calls
// useThemeBridge with `themeValue ?? 'system'`), start a sibling `*.dom.test.tsx`
// file rather than fighting these module-level mocks.
mock.module('@/hooks/use-theme-bridge', () => ({
  useThemeBridge: () => {},
}));

const { ConfigProvider, useConfigContext } = await import('./config-provider');

const EXPECTED_NULL_KEYS = [
  'userBinding',
  'projectBinding',
  'projectLocalBinding',
  'okignoreBinding',
  'userConfig',
  'projectConfig',
  'projectLocalConfig',
  'merged',
] as const;

function Consumer() {
  const ctx = useConfigContext();
  return (
    <div data-testid="consumer">
      {EXPECTED_NULL_KEYS.map((key) => (
        <span key={key} data-testid={`field:${key}`}>
          {String(ctx[key])}
        </span>
      ))}
      <span data-testid="field:userSynced">{String(ctx.userSynced)}</span>
      <span data-testid="field:projectLocalSynced">{String(ctx.projectLocalSynced)}</span>
      <span data-testid="field:okignoreSynced">{String(ctx.okignoreSynced)}</span>
    </div>
  );
}

describe('ConfigProvider runtime (Tier-3)', () => {
  afterEach(() => {
    cleanup();
  });

  test('propagates the all-null value when collabUrl is null (cold-start window)', () => {
    render(
      <ConfigProvider collabUrl={null}>
        <Consumer />
      </ConfigProvider>,
    );

    expect(screen.getByTestId('consumer')).toBeDefined();

    for (const key of EXPECTED_NULL_KEYS) {
      expect(screen.getByTestId(`field:${key}`).textContent).toBe('null');
    }
    expect(screen.getByTestId('field:userSynced').textContent).toBe('false');
    expect(screen.getByTestId('field:projectLocalSynced').textContent).toBe('false');
    expect(screen.getByTestId('field:okignoreSynced').textContent).toBe('false');
  });

  describe('useConfigContext outside provider', () => {
    let consoleErrorSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
    });

    test('throws the documented message when used outside <ConfigProvider />', () => {
      expect(() => {
        render(<Consumer />);
      }).toThrow('useConfigContext must be used within <ConfigProvider />');
    });
  });
});
