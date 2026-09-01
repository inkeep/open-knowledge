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
