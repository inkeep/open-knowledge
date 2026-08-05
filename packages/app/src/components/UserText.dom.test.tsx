/**
 * `UserText` marks a string as the user's own so it resolves its own writing
 * direction. jsdom has no bidi engine, so what is checkable here is the markup
 * contract; that the direction actually resolves per string in a real engine is
 * `tests/stress/user-text-direction.e2e.ts`.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { UserText } from './UserText';

describe('UserText', () => {
  afterEach(cleanup);

  test('renders the string in an element that takes its direction from the text', () => {
    render(<UserText data-testid="subject">notes.md</UserText>);

    const rendered = screen.getByTestId('subject');
    expect(rendered.textContent).toBe('notes.md');
    expect(rendered.tagName).toBe('BDI');
  });

  test('carries layout classes, so it can replace the span that held the string', () => {
    render(
      <UserText className="min-w-0 truncate" data-testid="subject">
        a-very-long-document-name.md
      </UserText>,
    );

    expect(screen.getByTestId('subject').className).toBe('min-w-0 truncate');
  });

  test('isolates markup-bearing content as one string', () => {
    // Search hits arrive as a highlighted fragment tree rather than a bare
    // string; the isolate has to sit around the whole value, since the
    // fragments are one thing the user wrote.
    render(
      <UserText data-testid="subject">
        <mark>quarterly</mark>-report.md
      </UserText>,
    );

    const rendered = screen.getByTestId('subject');
    expect(rendered.tagName).toBe('BDI');
    expect(rendered.textContent).toBe('quarterly-report.md');
  });
});
