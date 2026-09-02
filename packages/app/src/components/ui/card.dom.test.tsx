import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { expectVisualClassTokens } from '@/test-utils/visual-contract';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './card';

afterEach(cleanup);

function slot(container: HTMLElement, name: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  if (!el) throw new Error(`no element rendered for slot "${name}"`);
  return el;
}

describe('Card', () => {
  test('renders a plain div by default, contributing no landmark', () => {
    const { container } = render(<Card>body</Card>);

    expect(slot(container, 'card').tagName).toBe('DIV');
    expect(screen.queryByRole('region')).toBeNull();
  });

  test('asChild renders the caller element and keeps it a named landmark', () => {
    render(
      <Card asChild>
        <section aria-label="Stay in the loop">body</section>
      </Card>,
    );

    const region = screen.getByRole('region', { name: 'Stay in the loop' });

    expect(region.tagName).toBe('SECTION');
    expect(region.getAttribute('data-slot')).toBe('card');
  });

  test('asChild merges the card classes onto the caller element', () => {
    const { container } = render(
      <Card asChild className="mx-1">
        <section aria-label="Share feedback">body</section>
      </Card>,
    );

    expectVisualClassTokens(slot(container, 'card').getAttribute('class'), [
      'bg-card',
      'text-card-foreground',
      'mx-1',
    ]);
  });

  test('size drives the spacing custom property every slot reads', () => {
    const { container: withDefault } = render(<Card>body</Card>);
    const defaultCard = slot(withDefault, 'card');

    expect(defaultCard.getAttribute('data-size')).toBe('default');
    expectVisualClassTokens(defaultCard.getAttribute('class'), ['[--card-spacing:--spacing(4)]']);

    cleanup();

    const { container: withSm } = render(<Card size="sm">body</Card>);
    const smCard = slot(withSm, 'card');

    expect(smCard.getAttribute('data-size')).toBe('sm');
    expectVisualClassTokens(smCard.getAttribute('class'), [
      'data-[size=sm]:[--card-spacing:--spacing(3)]',
    ]);
  });

  test('caller className composes with the base classes rather than replacing them', () => {
    const { container } = render(<Card className="mx-1 mb-1">body</Card>);

    expectVisualClassTokens(slot(container, 'card').getAttribute('class'), [
      'bg-card',
      'rounded-xl',
      'mx-1',
      'mb-1',
    ]);
  });

  test('every slot marks itself so the root and header can select on it', () => {
    const { container } = render(
      <Card>
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>Description</CardDescription>
          <CardAction>Action</CardAction>
        </CardHeader>
        <CardContent>Content</CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>,
    );

    for (const name of [
      'card-header',
      'card-title',
      'card-description',
      'card-action',
      'card-content',
      'card-footer',
    ]) {
      expect(slot(container, name).textContent).toMatch(/\S/);
    }
  });

  test('root drops its bottom padding when a footer is present', () => {
    const { container } = render(
      <Card>
        <CardContent>Content</CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>,
    );

    expectVisualClassTokens(slot(container, 'card').getAttribute('class'), [
      'has-data-[slot=card-footer]:pb-0',
    ]);
  });

  test('header lays an action out beside the title only when one is present', () => {
    const { container } = render(
      <Card>
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardAction>Action</CardAction>
        </CardHeader>
      </Card>,
    );

    expectVisualClassTokens(slot(container, 'card-header').getAttribute('class'), [
      'has-data-[slot=card-action]:grid-cols-[1fr_auto]',
    ]);
    expectVisualClassTokens(slot(container, 'card-action').getAttribute('class'), [
      'col-start-2',
      'justify-self-end',
    ]);
  });

  test('slots forward arbitrary props to their element', () => {
    const { container } = render(
      <Card>
        <CardContent data-testid="body" id="card-body">
          Content
        </CardContent>
      </Card>,
    );

    const content = slot(container, 'card-content');

    expect(content.id).toBe('card-body');
    expect(screen.getByTestId('body')).toBe(content);
  });

  test('footer className composes with its border and fill', () => {
    const { container } = render(
      <Card>
        <CardFooter className="justify-between">Footer</CardFooter>
      </Card>,
    );

    expectVisualClassTokens(slot(container, 'card-footer').getAttribute('class'), [
      'border-t',
      'bg-muted/50',
      'justify-between',
    ]);
  });
});
