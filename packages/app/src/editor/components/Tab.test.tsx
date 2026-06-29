
import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { Tab } from './Tab.tsx';

describe('Tab — strip-label contract', () => {
  test('explicit label flows to data-tab-label verbatim', () => {
    const html = renderToString(<Tab label="Quick start">body</Tab>);
    expect(html).toContain('data-tab-label="Quick start"');
  });

  test('empty / whitespace-only label falls back to "Tab"', () => {
    expect(renderToString(<Tab label="">body</Tab>)).toContain('data-tab-label="Tab"');
    expect(renderToString(<Tab label="   ">body</Tab>)).toContain('data-tab-label="Tab"');
  });

  test('omitted label falls back to "Tab"', () => {
    const html = renderToString(<Tab>body</Tab>);
    expect(html).toContain('data-tab-label="Tab"');
  });

  test('label is trimmed (leading/trailing whitespace stripped)', () => {
    const html = renderToString(<Tab label="  npm  ">body</Tab>);
    expect(html).toContain('data-tab-label="npm"');
    expect(html).not.toContain('data-tab-label="  npm  "');
  });
});

describe('Tab — ARIA wiring', () => {
  test('section carries role="tabpanel"', () => {
    const html = renderToString(<Tab label="x">body</Tab>);
    expect(html).toMatch(/<section[^>]+role="tabpanel"/);
  });

  test('user-provided id sets the panel id (deep-link anchor)', () => {
    const html = renderToString(
      <Tab label="x" id="manual-setup">
        body
      </Tab>,
    );
    expect(html).toContain('id="manual-setup"');
    expect(html).toContain('data-tab-id="manual-setup"');
  });

  test('aria-labelledby points at the panel id + "-tab" suffix (the strip pill)', () => {
    const html = renderToString(
      <Tab label="x" id="manual-setup">
        body
      </Tab>,
    );
    expect(html).toContain('aria-labelledby="manual-setup-tab"');
  });

  test('omitted id still produces a stable panel id (useId-derived fallback)', () => {
    const html = renderToString(<Tab label="x">body</Tab>);
    expect(html).toMatch(/id="tab-panel-[^"]+"/);
    expect(html).toMatch(/aria-labelledby="tab-panel-[^"]+-tab"/);
    expect(html).toMatch(/data-tab-id="tab-panel-[^"]+"/);
  });
});
