import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { Accordion } from './Accordion.tsx';

describe('Accordion — chevron refactor', () => {
  test('renders a chevron <svg> as a child of <summary>', () => {
    const html = renderToString(<Accordion title="Hello">body</Accordion>);
    expect(html).toContain('accordion-chevron');
    expect(html).toMatch(/<summary[^>]*>[^<]*<svg[^>]*accordion-chevron/);
  });

  test('chevron renders before the title group', () => {
    const html = renderToString(<Accordion title="Hello">body</Accordion>);
    const chevronIdx = html.indexOf('accordion-chevron');
    const titleGroupIdx = html.indexOf('accordion-title-group');
    expect(chevronIdx).toBeGreaterThan(-1);
    expect(titleGroupIdx).toBeGreaterThan(-1);
    expect(chevronIdx).toBeLessThan(titleGroupIdx);
  });

  test('chevron coexists with the icon override (both before title)', () => {
    const html = renderToString(
      <Accordion title="Hello" icon="lucide:ChevronRight">
        body
      </Accordion>,
    );
    expect(html).toContain('accordion-chevron');
    expect(html).toMatch(/class="[^"]*\baccordion-icon\b/);
    const chevronIdx = html.indexOf('accordion-chevron');
    const iconClassMatch = html.match(/class="[^"]*\baccordion-icon\b/);
    expect(iconClassMatch).not.toBeNull();
    const iconClassIdx = iconClassMatch ? (iconClassMatch.index ?? -1) : -1;
    const titleIdx = html.indexOf('accordion-title-group');
    expect(chevronIdx).toBeLessThan(iconClassIdx);
    expect(iconClassIdx).toBeLessThan(titleIdx);
  });

  test('defaultOpen=true renders the open attribute on <details>', () => {
    const html = renderToString(
      <Accordion title="Hello" defaultOpen>
        body
      </Accordion>,
    );
    expect(html).toMatch(/<details[^>]+open[\s=>]/);
  });

  test('defaultOpen omitted does NOT render the open attribute', () => {
    const html = renderToString(<Accordion title="Hello">body</Accordion>);
    expect(html).not.toMatch(/<details[^>]+open[\s=>]/);
  });
});
