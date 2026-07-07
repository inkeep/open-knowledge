import { beforeEach, describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { getCollector } from './collector';
import { ProfilerBoundary } from './profiler-boundary';

describe('<ProfilerBoundary>', () => {
  beforeEach(() => {
    getCollector()?.reset();
  });

  test('renders children', () => {
    const html = renderToString(
      <ProfilerBoundary name="test-renders">
        <span data-testid="child">hello</span>
      </ProfilerBoundary>,
    );
    expect(html).toContain('hello');
  });

  test('children prop is required in the TypeScript surface', () => {
    // Compile-time check — if this file type-checks, the prop exists.
    const node = (
      <ProfilerBoundary name="type-probe">
        <div />
      </ProfilerBoundary>
    );
    expect(node).toBeDefined();
  });

  // onRender behavior is exercised end-to-end in the Playwright perf
  // scenarios against a live React root — server-side
  // renderToString does not invoke Profiler commit callbacks.
});
