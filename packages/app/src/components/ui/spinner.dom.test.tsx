/**
 * DOM-substrate tests for Spinner. This primitive is the single loading
 * indicator across the app, so its accessibility contract is what every call
 * site inherits — including the `aria-hidden` escape hatch that keeps a spinner
 * inside an already-labelled wrapper from being announced twice.
 */

import { cleanup, render, screen } from '@testing-library/react';
import type { LucideProps } from 'lucide-react';
import { RefreshCw } from 'lucide-react';
import { afterEach, describe, expect, test } from 'vitest';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';
import { Spinner } from './spinner';

afterEach(cleanup);

function svgOf(container: HTMLElement): SVGElement {
  const svg = container.querySelector('svg');
  if (!svg) throw new Error('Spinner rendered no svg');
  return svg;
}

describe('Spinner', () => {
  test('exposes a status role with an accessible name by default', () => {
    render(<Spinner />);

    const spinner = screen.getByRole('status');

    // The name must be non-empty: a Lingui `t` that fails to resolve renders as
    // an empty string, which would leave the element silently unnamed.
    expect(spinner.getAttribute('aria-label')).toMatch(/\S/);
  });

  test('animates but stands still under prefers-reduced-motion', () => {
    const { container } = render(<Spinner />);

    expectVisualClassTokens(svgOf(container).getAttribute('class'), [
      'animate-spin',
      'motion-reduce:animate-none',
    ]);
  });

  test('caller className composes with the base classes rather than replacing them', () => {
    const { container } = render(<Spinner className="size-8 text-primary" />);

    expectVisualClassTokens(svgOf(container).getAttribute('class'), [
      'animate-spin',
      'motion-reduce:animate-none',
      'size-8',
      'text-primary',
    ]);
  });

  test('renders the supplied icon instead of the default glyph', () => {
    const { container: withDefault } = render(<Spinner />);
    const defaultMarkup = svgOf(withDefault).innerHTML;

    cleanup();

    const { container: withRefresh } = render(<Spinner icon={RefreshCw} />);
    const refreshMarkup = svgOf(withRefresh).innerHTML;

    expect(refreshMarkup).not.toBe(defaultMarkup);
  });

  test('forwards the spinner props to the supplied icon component', () => {
    let seen: LucideProps | undefined;
    const ProbeIcon = (props: LucideProps) => {
      seen = props;
      return <svg data-testid="probe" />;
    };

    render(<Spinner icon={ProbeIcon} />);

    expect(seen?.role).toBe('status');
    expect(seen?.['aria-label']).toEqual(expect.stringMatching(/\S/));
  });

  test('aria-hidden wins over the default role and label', () => {
    // The migration relies on this: a spinner inside a labelled `role="status"`
    // wrapper must stay out of the a11y tree or it is announced twice.
    render(<Spinner aria-hidden="true" />);

    expect(screen.queryByRole('status')).toBeNull();
  });

  test('caller-supplied aria-label overrides the default', () => {
    render(<Spinner aria-label="Syncing project" />);

    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Syncing project');
  });
});
