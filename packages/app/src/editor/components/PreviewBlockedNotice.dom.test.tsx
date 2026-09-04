import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
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
    expect(screen.getByText(/more than 2 requests were blocked/i)).toBeDefined();
  });

  test('flags display overflow when more were listed than shown', () => {
    const blocked = Array.from({ length: 6 }, (_v, i) => ({
      directive: 'img-src',
      uri: `http://a/${i}.png`,
    }));
    render(<PreviewBlockedNotice blocked={blocked} truncated={false} onDismiss={() => {}} />);
    expect(screen.getByText(/6 requests blocked by the preview's security policy/)).toBeDefined();
    expect(screen.getByText(/more requests were blocked/i)).toBeDefined();
  });

  test('the dismiss control is wired to onDismiss', () => {
    const onDismiss = vi.fn(() => {});
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
