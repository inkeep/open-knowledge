import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { THEME_COLOR_PROPERTIES } from './theme-color-properties';
import {
  TRANSITION_ATTRIBUTE,
  TRANSITION_FADING_ATTRIBUTE,
  TRANSITION_STYLE_ID,
} from './theme-color-transitions';

let armThemeColorTransitions: typeof import('./theme-color-transitions').armThemeColorTransitions;
let useThemeColorTransitions: typeof import('./theme-color-transitions').useThemeColorTransitions;

function activeRootFade(document: Document): void {
  Object.defineProperty(document.documentElement, 'getAnimations', {
    value: () => [{ transitionProperty: '--background' }],
  });
}

describe('theme color transitions', () => {
  beforeEach(async () => {
    vi.resetModules();
    const transitions = await import('./theme-color-transitions');
    armThemeColorTransitions = transitions.armThemeColorTransitions;
    useThemeColorTransitions = transitions.useThemeColorTransitions;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute(TRANSITION_ATTRIBUTE);
    document.documentElement.removeAttribute(TRANSITION_FADING_ATTRIBUTE);
    document.documentElement.removeAttribute('data-color-theme');
    document.getElementById(TRANSITION_STYLE_ID)?.remove();
  });

  test('leaves the document instant when typed property registration is unavailable', () => {
    vi.stubGlobal('CSS', {});

    const alternateDocument = document.implementation.createHTMLDocument();

    expect(armThemeColorTransitions(alternateDocument)).toBe(false);
    expect(alternateDocument.documentElement.hasAttribute(TRANSITION_ATTRIBUTE)).toBe(false);
    expect(alternateDocument.getElementById(TRANSITION_STYLE_ID)).toBeNull();
  });

  test('reports a registration failure from the animation frame', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('CSS', {
      registerProperty: () => {
        throw new DOMException('invalid syntax', 'SyntaxError');
      },
    });

    function ReadyProbe() {
      useThemeColorTransitions(true);
      return null;
    }

    render(<ReadyProbe />);
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'theme-color-transitions-arm-failed',
        error: 'SyntaxError: invalid syntax',
      }),
    );
  });

  test('arms every semantic token only after readiness', async () => {
    const registerProperty = vi.fn();
    vi.stubGlobal('CSS', { registerProperty });

    function ReadyProbe({ ready }: { ready: boolean }) {
      useThemeColorTransitions(ready);
      return null;
    }

    const view = render(<ReadyProbe ready={false} />);
    expect(registerProperty).not.toHaveBeenCalled();
    expect(document.documentElement.hasAttribute(TRANSITION_ATTRIBUTE)).toBe(false);

    view.rerender(<ReadyProbe ready />);
    expect(registerProperty).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    expect(registerProperty).toHaveBeenCalledTimes(THEME_COLOR_PROPERTIES.length);
    expect(THEME_COLOR_PROPERTIES).not.toContain('--radius');
    expect(document.documentElement.hasAttribute(TRANSITION_ATTRIBUTE)).toBe(true);
    expect(document.getElementById(TRANSITION_STYLE_ID)?.textContent).toContain(
      '--ansi-bright-white 200ms ease-out',
    );
    expect(document.getElementById(TRANSITION_STYLE_ID)?.textContent).toContain(
      '--sidebar-primary 200ms ease-out',
    );
  });

  test('accepts duplicate typed property registration after a module reload', () => {
    const registerProperty = vi.fn(() => {
      throw new DOMException('already registered', 'InvalidModificationError');
    });
    vi.stubGlobal('CSS', { registerProperty });

    const alternateDocument = document.implementation.createHTMLDocument();
    Object.defineProperty(alternateDocument, 'defaultView', { value: window });
    expect(armThemeColorTransitions(alternateDocument)).toBe(true);
    expect(registerProperty).toHaveBeenCalledTimes(THEME_COLOR_PROPERTIES.length);
    expect(alternateDocument.documentElement.hasAttribute(TRANSITION_ATTRIBUTE)).toBe(true);
  });

  test('does not add a second guard after a module reload', async () => {
    const registerProperty = vi.fn();
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    vi.stubGlobal('CSS', { registerProperty });

    expect(armThemeColorTransitions()).toBe(true);
    vi.resetModules();
    const reloaded = await import('./theme-color-transitions');

    expect(reloaded.armThemeColorTransitions()).toBe(true);
    expect(registerProperty).toHaveBeenCalledTimes(THEME_COLOR_PROPERTIES.length);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  test('cancels descendant color transitions while preserving shadow geometry and transforms', async () => {
    vi.stubGlobal('CSS', { registerProperty: vi.fn() });
    const fadeDocument = document.implementation.createHTMLDocument();
    Object.defineProperty(fadeDocument, 'defaultView', { value: window });
    activeRootFade(fadeDocument);
    expect(armThemeColorTransitions(fadeDocument)).toBe(true);

    const child = fadeDocument.createElement('div');
    const color = { transitionProperty: 'background-color', cancel: vi.fn() };
    const decoration = { transitionProperty: 'text-decoration-color', cancel: vi.fn() };
    const gradient = { transitionProperty: '--tw-gradient-from', cancel: vi.fn() };
    const shadow = { transitionProperty: 'box-shadow', cancel: vi.fn() };
    const transform = { transitionProperty: 'transform', cancel: vi.fn() };
    Object.defineProperty(child, 'getAnimations', {
      value: () => [color, decoration, gradient, shadow, transform],
    });
    fadeDocument.body.appendChild(child);

    await act(async () => {
      fadeDocument.documentElement.setAttribute('data-color-theme', 'dracula');
      await Promise.resolve();
    });
    expect(fadeDocument.documentElement.hasAttribute(TRANSITION_FADING_ATTRIBUTE)).toBe(true);

    const event = new Event('transitionrun', { bubbles: true });
    Object.defineProperty(event, 'propertyName', { value: 'background-color' });
    child.dispatchEvent(event);

    expect(color.cancel).toHaveBeenCalledOnce();
    expect(decoration.cancel).toHaveBeenCalledOnce();
    expect(gradient.cancel).toHaveBeenCalledOnce();
    expect(shadow.cancel).not.toHaveBeenCalled();
    expect(transform.cancel).not.toHaveBeenCalled();
    child.remove();
  });

  test('cancels color transitions already running when the theme mutation settles', async () => {
    vi.stubGlobal('CSS', { registerProperty: vi.fn() });
    const fadeDocument = document.implementation.createHTMLDocument();
    Object.defineProperty(fadeDocument, 'defaultView', { value: window });
    activeRootFade(fadeDocument);
    expect(armThemeColorTransitions(fadeDocument)).toBe(true);

    const child = fadeDocument.createElement('div');
    const color = {
      transitionProperty: 'background-color',
      effect: { target: child },
      cancel: vi.fn(),
    };
    const shadow = {
      transitionProperty: 'box-shadow',
      effect: { target: child },
      cancel: vi.fn(),
    };
    Object.defineProperty(fadeDocument, 'getAnimations', { value: () => [color, shadow] });
    fadeDocument.body.appendChild(child);

    await act(async () => {
      fadeDocument.documentElement.setAttribute('data-color-theme', 'dracula');
      await Promise.resolve();
    });

    expect(color.cancel).toHaveBeenCalledOnce();
    expect(shadow.cancel).not.toHaveBeenCalled();
    child.remove();
  });

  test('clears the guard immediately when the root remains instant', async () => {
    vi.stubGlobal('CSS', { registerProperty: vi.fn() });
    const fadeDocument = document.implementation.createHTMLDocument();
    Object.defineProperty(fadeDocument, 'defaultView', { value: window });
    expect(armThemeColorTransitions(fadeDocument)).toBe(true);

    await act(async () => {
      fadeDocument.documentElement.setAttribute('data-color-theme', 'dracula');
      await Promise.resolve();
    });

    expect(fadeDocument.documentElement.hasAttribute(TRANSITION_FADING_ATTRIBUTE)).toBe(false);
  });

  test('ignores idempotent root attribute writes', async () => {
    vi.stubGlobal('CSS', { registerProperty: vi.fn() });
    const fadeDocument = document.implementation.createHTMLDocument();
    Object.defineProperty(fadeDocument, 'defaultView', { value: window });
    fadeDocument.documentElement.setAttribute('data-color-theme', 'dracula');
    activeRootFade(fadeDocument);
    const getAnimations = vi.fn(() => []);
    Object.defineProperty(fadeDocument, 'getAnimations', { value: getAnimations });
    expect(armThemeColorTransitions(fadeDocument)).toBe(true);

    await act(async () => {
      fadeDocument.documentElement.setAttribute('data-color-theme', 'dracula');
      await Promise.resolve();
    });

    expect(fadeDocument.documentElement.hasAttribute(TRANSITION_FADING_ATTRIBUTE)).toBe(false);
    expect(getAnimations).not.toHaveBeenCalled();
  });

  test('surfaces registration failures other than duplicate registration', () => {
    vi.stubGlobal('CSS', {
      registerProperty: () => {
        throw new DOMException('invalid syntax', 'SyntaxError');
      },
    });

    const alternateDocument = document.implementation.createHTMLDocument();
    Object.defineProperty(alternateDocument, 'defaultView', { value: window });

    expect(() => armThemeColorTransitions(alternateDocument)).toThrow('invalid syntax');
  });
});
