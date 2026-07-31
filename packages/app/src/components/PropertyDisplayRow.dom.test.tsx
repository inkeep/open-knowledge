import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { Input } from '@/components/ui/input';
import { PropertyDisplayRow } from './PropertyDisplayRow';

describe('PropertyDisplayRow', () => {
  test('associates editable labels and keeps the shared gutter', () => {
    const { container } = render(
      <PropertyDisplayRow icon={<span>icon</span>} label="name" htmlFor="name-input">
        <Input id="name-input" />
      </PropertyDisplayRow>,
    );

    expect(screen.getByText('name').closest('label')?.htmlFor).toBe('name-input');
    expect(container.querySelector('[data-slot="property-row-gutter"]')).not.toBeNull();
  });

  test('renders static keys without claiming a label relationship', () => {
    render(
      <PropertyDisplayRow icon={<span>icon</span>} label="tags">
        <span>Empty</span>
      </PropertyDisplayRow>,
    );

    expect(screen.getByText('tags').closest('label')).toBeNull();
  });
});
