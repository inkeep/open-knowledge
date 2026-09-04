import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { Panel, PanelBody, PanelFooter, PanelHeader } from './panel';

describe('PanelFooter', () => {
  test('sits outside the scroll container, not within it', () => {
    render(
      <Panel>
        <PanelHeader>Queue</PanelHeader>
        <PanelBody>
          <p>an item</p>
        </PanelBody>
        <PanelFooter>
          <p>Send</p>
        </PanelFooter>
      </Panel>,
    );

    const body = document.querySelector('[data-slot="panel-body"]');
    const footer = document.querySelector('[data-slot="panel-footer"]');
    expect(body).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(body?.contains(footer as Node)).toBe(false);
    expect(screen.getByText('Send')).toBeTruthy();
  });

  test('the body scrolls and the footer does not shrink', () => {
    render(
      <Panel>
        <PanelBody>
          <p>items</p>
        </PanelBody>
        <PanelFooter>
          <p>Send</p>
        </PanelFooter>
      </Panel>,
    );

    const body = document.querySelector('[data-slot="panel-body"]');
    const footer = document.querySelector('[data-slot="panel-footer"]');
    expect(body?.className).toContain('overflow-y-auto');
    expect(footer?.className).toContain('shrink-0');
    expect(footer?.className).not.toContain('overflow-y-auto');
  });
});
