import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { Callout } from './Callout.tsx';

describe('Callout — chevron refactor (collapsible mode)', () => {
  test('static mode does not render a chevron', () => {
    const html = renderToString(
      <Callout type="note" title="Static">
        body
      </Callout>,
    );
    expect(html).not.toContain('callout-chevron');
  });

  test('collapsible=true renders a chevron <svg> inside <summary>', () => {
    const html = renderToString(
      <Callout type="note" title="Hello" collapsible>
        body
      </Callout>,
    );
    expect(html).toContain('callout-chevron');
    expect(html).toMatch(/<summary[^>]*>[\s\S]*<svg[^>]*callout-chevron[\s\S]*<\/summary>/);
  });

  test('collapsible=true with defaultOpen={false} omits the open attribute', () => {
    const html = renderToString(
      <Callout type="warning" collapsible defaultOpen={false}>
        body
      </Callout>,
    );
    expect(html).not.toMatch(/<details[^>]+open[\s=>]/);
  });

  test('collapsible=true defaults defaultOpen to true (renders open)', () => {
    const html = renderToString(
      <Callout type="warning" collapsible>
        body
      </Callout>,
    );
    expect(html).toMatch(/<details[^>]+open[\s=>]/);
  });

  test('collapsible chevron sits after the header content', () => {
    const html = renderToString(
      <Callout type="note" title="Heading" collapsible>
        body
      </Callout>,
    );
    const chevronIdx = html.indexOf('callout-chevron');
    const titleIdx = html.indexOf('callout-title');
    expect(chevronIdx).toBeGreaterThan(-1);
    expect(titleIdx).toBeGreaterThan(-1);
    expect(chevronIdx).toBeGreaterThan(titleIdx);
  });
});
