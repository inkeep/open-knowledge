/**
 * Callout — unit coverage for the chevron-as-real-DOM refactor.
 *
 * The collapsible-mode chevron is rendered as a real `<svg>` child of
 * `<summary>` (lucide ChevronRight) so the clipboard live-DOM walker
 * captures it via `cloneNode(true)`. A pseudo-element ::before would be
 * silently dropped on cross-app paste, losing the chevron decoration.
 *
 * Repo convention: no @testing-library, no happy-dom. Structural cases via
 * `renderToString`.
 */

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
    // Real <svg> child of <summary>, not a ::before pseudo. Chevron sits
    // after the header in DOM order; .callout-summary's `flex justify-between`
    // pushes it to the right edge visually.
    expect(html).toContain('callout-chevron');
    expect(html).toMatch(/<summary[^>]*>[\s\S]*<svg[^>]*callout-chevron[\s\S]*<\/summary>/);
  });

  test('collapsible=true with defaultOpen={false} omits the open attribute', () => {
    const html = renderToString(
      <Callout type="warning" collapsible defaultOpen={false}>
        body
      </Callout>,
    );
    // Open attr would appear as `open=""` or `open` — neither should be present.
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
