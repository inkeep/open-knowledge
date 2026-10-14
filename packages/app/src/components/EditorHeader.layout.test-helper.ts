import { vi } from 'vitest';

export interface HeaderMetrics {
  header: number;
  leading: number;
  leadingOffset?: number;
  tabs?: number;
  trailing: number;
  collapsedTrailing?: number;
  paneButton?: number;
}

export function mockHeaderMetrics(source: HeaderMetrics | (() => HeaderMetrics)) {
  const current = typeof source === 'function' ? source : () => source;
  const offsetWidth = vi
    .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
    .mockImplementation(function (this: HTMLElement) {
      const { header, leading, tabs = 0, trailing, collapsedTrailing, paneButton = 0 } = current();
      if (this.tagName === 'HEADER') return header;
      if (this.hasAttribute('data-editor-header-leading-actions')) return leading;
      if (this.hasAttribute('data-editor-header-tabs')) return tabs;
      if (this.hasAttribute('data-editor-header-actions')) {
        const collapsed =
          this.querySelector('[data-testid="header-overflow-actions-trigger"]') !== null;
        const paneRow =
          this.querySelectorAll('[data-testid^="header-pane-button-"]').length * paneButton;
        return (
          (collapsed && collapsedTrailing !== undefined ? collapsedTrailing : trailing) + paneRow
        );
      }
      return 0;
    });
  const offsetLeft = vi
    .spyOn(HTMLElement.prototype, 'offsetLeft', 'get')
    .mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute('data-editor-header-leading-actions')
        ? (current().leadingOffset ?? 0)
        : 0;
    });
  return () => {
    offsetLeft.mockRestore();
    offsetWidth.mockRestore();
  };
}
