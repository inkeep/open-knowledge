/**
 * Render tests for `PreviewBlockedNotice` — the friendly, dismissible banner
 * the code-block preview shows when its CSP (or the host's security layer)
 * blocks a request.
 *
 * Only a renderer can prove the user-facing contract: the notice is announced
 * (role=status), names what was blocked, is count-aware (singular vs plural),
 * flags truncation, and wires its dismiss control. The iframe→parent reporting
 * + message parsing are covered in `preview-iframe-csp-violation.test.ts`.
 *
 * Lingui macros resolve through the English-passthrough shim; substrate is
 * jsdom via `bun run test:dom`.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PreviewBlockedNotice } from './PreviewBlockedNotice';

const DISMISS_NAME = 'Dismiss notice';

describe('PreviewBlockedNotice', () => {
  afterEach(() => {
    cleanup();
  });

  test('announces itself as a status region', () => {
    render(
      <PreviewBlockedNotice
        blocked={[{ directive: 'img-src', uri: 'http://insecure.example/tile.png' }]}
        truncated={false}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByRole('status')).toBeDefined();
  });

  test('names the blocked request (uri + directive)', () => {
    render(
      <PreviewBlockedNotice
        blocked={[{ directive: 'img-src', uri: 'http://insecure.example/tile.png' }]}
        truncated={false}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText('http://insecure.example/tile.png')).toBeDefined();
    expect(screen.getByText('img-src')).toBeDefined();
  });

  test('renders (inline) when the blocked uri is empty', () => {
    // Inline-script / eval violations report an empty blockedURI; the fallback
    // must still name the entry rather than render a blank line.
    render(
      <PreviewBlockedNotice
        blocked={[{ directive: 'script-src', uri: '' }]}
        truncated={false}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText('(inline)')).toBeDefined();
  });

  test('singular heading for one blocked request', () => {
    render(
      <PreviewBlockedNotice
        blocked={[{ directive: 'img-src', uri: 'http://a/1.png' }]}
        truncated={false}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(/1 request blocked by the preview's security policy/)).toBeDefined();
  });

  test('plural heading for multiple blocked requests', () => {
    render(
      <PreviewBlockedNotice
        blocked={[
          { directive: 'img-src', uri: 'http://a/1.png' },
          { directive: 'font-src', uri: 'http://a/f.woff' },
        ]}
        truncated={false}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(/2 requests blocked by the preview's security policy/)).toBeDefined();
  });

  test('a truncated report shows a floor count, not an exact total', () => {
    render(
      <PreviewBlockedNotice
        blocked={[
          { directive: 'img-src', uri: 'http://a/1.png' },
          { directive: 'img-src', uri: 'http://a/2.png' },
        ]}
        truncated={true}
        onDismiss={() => {}}
      />,
    );
    // "More than N" — never an exact count when the report was capped.
    expect(screen.getByText(/more than 2 requests were blocked/i)).toBeDefined();
  });

  test('flags display overflow when more were listed than shown', () => {
    // 6 blocked, not report-truncated: only VISIBLE_LIMIT (4) are listed, so the
    // notice must say more were blocked even though the heading count is exact.
    const blocked = Array.from({ length: 6 }, (_v, i) => ({
      directive: 'img-src',
      uri: `http://a/${i}.png`,
    }));
    render(<PreviewBlockedNotice blocked={blocked} truncated={false} onDismiss={() => {}} />);
    expect(screen.getByText(/6 requests blocked by the preview's security policy/)).toBeDefined();
    expect(screen.getByText(/more requests were blocked/i)).toBeDefined();
  });

  test('the dismiss control is wired to onDismiss', () => {
    const onDismiss = mock(() => {});
    render(
      <PreviewBlockedNotice
        blocked={[{ directive: 'img-src', uri: 'http://a/1.png' }]}
        truncated={false}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: DISMISS_NAME }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
