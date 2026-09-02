import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import * as linguiShim from '../../tests/lingui-macro-shim';

vi.doMock('@lingui/react/macro', () => linguiShim);

const { ReadonlyPropertyPanel } = await import('./ReadonlyPropertyPanel');

describe('ReadonlyPropertyPanel', () => {
  test('renders a Properties row per frontmatter key with its value', () => {
    const { container } = render(
      <ReadonlyPropertyPanel
        text={'---\nname: my-skill\ndescription: does a thing\n---\n\n# Body\n'}
      />,
    );
    expect(screen.getByTestId('readonly-property-panel')).toBeTruthy();
    expect(screen.getByText('name')).toBeTruthy();
    expect(screen.getByText('description')).toBeTruthy();
    const nameValue = container.querySelector(
      '[data-testid="readonly-property-value"][data-key="name"]',
    );
    expect(nameValue?.textContent).toBe('my-skill');
    const descValue = container.querySelector(
      '[data-testid="readonly-property-value"][data-key="description"]',
    );
    expect(descValue?.textContent).toBe('does a thing');
  });

  test('renders nothing when the file has no frontmatter', () => {
    const { container } = render(
      <ReadonlyPropertyPanel text={'# Just a body\n\nNo YAML here.\n'} />,
    );
    expect(screen.queryByTestId('readonly-property-panel')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  test('renders scalar values as read-only text (no editable inputs)', () => {
    const { container } = render(
      <ReadonlyPropertyPanel text={'---\nname: foo\n---\n\n# Body\n'} />,
    );
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(screen.getByTestId('readonly-property-value').textContent).toBe('foo');
  });

  test('nested-object values fall back to the read-only complex preview', () => {
    render(
      <ReadonlyPropertyPanel
        text={'---\nname: foo\nmetadata:\n  version: 1\n  stage: beta\n---\n\n# Body\n'}
      />,
    );
    expect(screen.getByTestId('complex-value-widget')).toBeTruthy();
  });
});
