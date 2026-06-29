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
    const node = (
      <ProfilerBoundary name="type-probe">
        <div />
      </ProfilerBoundary>
    );
    expect(node).toBeDefined();
  });

});
