import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { MirrorSource } from './MirrorSource.tsx';

afterEach(() => {
  cleanup();
});

describe('a Mirror Source block', () => {
  test('written with a name that has no value, is labelled as unnamed', () => {
    const { container } = render(<MirrorSource name={true}>Body</MirrorSource>);
    expect(container.textContent).toContain('(no name)');
    expect(container.querySelector('[data-mirror-source-name="true"]')).toBeNull();
  });
});
