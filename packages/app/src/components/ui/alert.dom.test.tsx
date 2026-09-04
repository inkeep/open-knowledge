import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';
import { Alert, AlertAction, AlertDescription, AlertTitle } from './alert';

afterEach(cleanup);

describe('Alert', () => {
  test('announces as a live alert by default', () => {
    render(<Alert>Disk is full</Alert>);

    expect(screen.getByRole('alert').textContent).toBe('Disk is full');
  });

  test('a caller-supplied role replaces the assertive default', () => {
    render(<Alert role="note">Part of a plugin</Alert>);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('note').textContent).toBe('Part of a plugin');
  });

  test('title and description render as addressable slots inside the box', () => {
    render(
      <Alert>
        <AlertTitle>Update available</AlertTitle>
        <AlertDescription>Restart to apply it.</AlertDescription>
      </Alert>,
    );

    const alert = screen.getByRole('alert');
    expect(alert.querySelector('[data-slot="alert-title"]')?.textContent).toBe('Update available');
    expect(alert.querySelector('[data-slot="alert-description"]')?.textContent).toBe(
      'Restart to apply it.',
    );
  });

  test('the action slot renders inside the box', () => {
    render(
      <Alert>
        <AlertTitle>Heads up</AlertTitle>
        <AlertAction>
          <span>Dismiss</span>
        </AlertAction>
      </Alert>,
    );

    expect(screen.getByRole('alert').querySelector('[data-slot="alert-action"]')?.textContent).toBe(
      'Dismiss',
    );
  });

  test('gives an icon child its own column so the text block stays aligned', () => {
    render(
      <Alert>
        <svg aria-hidden="true" />
        <AlertTitle>Heads up</AlertTitle>
      </Alert>,
    );

    expectVisualClassTokens(screen.getByRole('alert').getAttribute('class'), [
      'grid',
      'has-[>svg]:grid-cols-[auto_1fr]',
    ]);
  });

  test('the destructive variant tints the box and its description', () => {
    render(<Alert variant="destructive">Deletion failed</Alert>);

    expectVisualClassTokens(screen.getByRole('alert').getAttribute('class'), [
      'text-destructive',
      '*:data-[slot=alert-description]:text-destructive/90',
    ]);
  });

  test('caller className composes with the base classes rather than replacing them', () => {
    render(<Alert className="my-3 bg-muted/40">Notice</Alert>);

    const className = screen.getByRole('alert').getAttribute('class');
    expectVisualClassTokens(className, ['grid', 'rounded-lg', 'my-3', 'bg-muted/40']);
    expect(className).not.toContain('bg-card');
  });
});
