import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';

let mockVisible = false;
mock.module('@/hooks/use-onboarding-card-visible', () => ({
  useOnboardingCardVisible: () => mockVisible,
}));

// Import the component AFTER the mock above registers, so its transitive
// `use-onboarding-card-visible` import binds to the stub.
const { OnboardingCardMount } = await import('./OnboardingCard');

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ documents: [] }), { status: 200 })),
  ) as never;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('OnboardingCardMount', () => {
  test('renders nothing when the visibility predicate is false', () => {
    mockVisible = false;
    const { container } = render(<OnboardingCardMount />);
    expect(container.firstChild).toBeNull();
  });

  test('renders the onboarding card when visible', () => {
    mockVisible = true;
    render(<OnboardingCardMount />);
    expect(screen.getByText('Get set up')).toBeTruthy();
  });
});
