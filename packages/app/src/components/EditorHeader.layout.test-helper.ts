import { act } from '@testing-library/react';
import { vi } from 'vitest';

export interface HeaderMetrics {
  header: number;
  leading: number;
  leadingOffset?: number;
  tabs?: number;
  trailing: number;
  collapsedTrailing?: number;
}

export function mockHeaderMetrics(source: HeaderMetrics | (() => HeaderMetrics)) {
  const current = typeof source === 'function' ? source : () => source;
  const offsetWidth = vi
    .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
    .mockImplementation(function (this: HTMLElement) {
      const { header, leading, tabs = 0, trailing, collapsedTrailing } = current();
      if (this.tagName === 'HEADER') return header;
      if (this.hasAttribute('data-editor-header-leading-actions')) return leading;
      if (this.hasAttribute('data-editor-header-tabs')) return tabs;
      if (this.hasAttribute('data-editor-header-actions')) {
        const collapsed =
          this.querySelector('[data-testid="header-overflow-actions-trigger"]') !== null;
        return collapsed && collapsedTrailing !== undefined ? collapsedTrailing : trailing;
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

export function captureResizeObserver() {
  const callbacks: ResizeObserverCallback[] = [];
  const original = globalThis.ResizeObserver;
  class CapturingResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      callbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = CapturingResizeObserver as unknown as typeof ResizeObserver;
  return {
    flush() {
      for (const callback of callbacks) {
        act(() => {
          callback([], {} as ResizeObserver);
        });
      }
    },
    restore() {
      globalThis.ResizeObserver = original;
    },
  };
}
