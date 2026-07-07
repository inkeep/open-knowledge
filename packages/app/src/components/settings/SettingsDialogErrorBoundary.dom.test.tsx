/**
 * RTL mount tests for SettingsDialogErrorBoundary: the containment
 * contract for a failed lazy Settings-body chunk. Without this boundary a
 * `React.lazy` dynamic-import rejection propagates to the React root and
 * unmounts the whole app (white screen, unrecoverable). These tests pin
 * that (a) the fallback renders on a child throw and (b) a sibling
 * rendered OUTSIDE the boundary stays mounted — i.e. the failure is
 * contained, the app survives. Throw injection follows the MaybeThrow
 * (precedent #43(d)); invocation via `bun run test:dom`.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { SettingsDialogErrorBoundary } from './SettingsDialogErrorBoundary';

let throwError: Error | null = null;

function MaybeThrow() {
  if (throwError) throw throwError;
  return <span data-testid="settings-body-payload">body</span>;
}

describe('SettingsDialogErrorBoundary (Tier-3 mount)', () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    throwError = null;
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleErrorSpy.mockRestore();
  });

  test('renders children when the body does not throw', () => {
    render(
      <SettingsDialogErrorBoundary>
        <MaybeThrow />
      </SettingsDialogErrorBoundary>,
    );
    expect(screen.getByTestId('settings-body-payload').textContent).toBe('body');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a body-chunk failure is contained: fallback renders AND a sibling outside the boundary stays mounted', () => {
    throwError = new Error(
      'Failed to fetch dynamically imported module: /assets/SettingsDialogBody.js',
    );
    render(
      <div>
        <span data-testid="app-survives">editor still here</span>
        <SettingsDialogErrorBoundary>
          <MaybeThrow />
        </SettingsDialogErrorBoundary>
      </div>,
    );

    // Containment proof: the sibling rendered OUTSIDE the boundary is still
    // mounted. Pre-fix, the lazy rejection unmounted the entire React root.
    expect(screen.getByTestId('app-survives').textContent).toBe('editor still here');

    const alert = screen.getByRole('alert');
    expect(alert.getAttribute('data-slot')).toBe('settings-body-error-boundary');
    expect(document.getElementById('settings-body-error-title')?.textContent).toBe(
      'Settings failed to load',
    );
    // The dynamic-import message gets the post-deploy-specific explanation.
    expect(screen.getByText(/newer version may have been deployed/i)).toBeTruthy();
    const reload = screen.getByRole('button', { name: /reload/i });
    expect(reload.tagName).toBe('BUTTON');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('a bare "Failed to fetch" error (without the dynamic-import phrase) gets the post-deploy explanation', () => {
    // Browsers/runtimes sometimes surface chunk-load failures as just
    // "Failed to fetch" without the longer dynamic-import phrasing —
    // the fallback's discriminator regex matches BOTH arms so users
    // see the post-deploy-specific message in either case. Pins the
    // second alternation arm so a future narrowing (e.g. dropping
    // the `Failed to fetch` token) does not silently downgrade those
    // errors to the generic message.
    throwError = new Error('Failed to fetch');
    render(
      <SettingsDialogErrorBoundary>
        <MaybeThrow />
      </SettingsDialogErrorBoundary>,
    );
    expect(screen.getByText(/newer version may have been deployed/i)).toBeTruthy();
  });

  test('a non-import error gets the generic explanation, still contained', () => {
    throwError = new Error('some unrelated render error');
    render(
      <div>
        <span data-testid="app-survives">alive</span>
        <SettingsDialogErrorBoundary>
          <MaybeThrow />
        </SettingsDialogErrorBoundary>
      </div>,
    );
    expect(screen.getByTestId('app-survives')).toBeTruthy();
    expect(screen.getByRole('alert').getAttribute('data-slot')).toBe(
      'settings-body-error-boundary',
    );
    expect(screen.getByText(/something went wrong loading the settings panel/i)).toBeTruthy();
  });
});
