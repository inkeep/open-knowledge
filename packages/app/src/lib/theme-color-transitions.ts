import { useEffect } from 'react';
import { isThemeColorProperty, THEME_COLOR_PROPERTIES } from './theme-color-properties';

export const TRANSITION_ATTRIBUTE = 'data-theme-color-transitions';
export const TRANSITION_STYLE_ID = 'ok-theme-color-transitions';
export const TRANSITION_FADING_ATTRIBUTE = 'data-theme-color-fading';
const TRANSITION_DURATION_MS = 200;

const transitionDeclarations = THEME_COLOR_PROPERTIES.map(
  (name) => `${name} ${TRANSITION_DURATION_MS}ms ease-out`,
).join(',');

const armedDocuments = new WeakSet<Document>();

function cssPropertiesApi(document: Document): typeof CSS | undefined {
  return document.defaultView?.CSS;
}

function registerProperties(document: Document): boolean {
  const css = cssPropertiesApi(document);
  if (typeof css?.registerProperty !== 'function') return false;
  const DOMExceptionCtor = document.defaultView?.DOMException;
  for (const name of THEME_COLOR_PROPERTIES) {
    try {
      css.registerProperty({
        name,
        syntax: '<color>',
        inherits: true,
        initialValue: 'transparent',
      });
    } catch (error) {
      if (
        typeof DOMExceptionCtor === 'function' &&
        error instanceof DOMExceptionCtor &&
        error.name === 'InvalidModificationError'
      ) {
        continue;
      }
      throw error;
    }
  }
  return true;
}

function installTransitionStyle(document: Document): void {
  if (document.getElementById(TRANSITION_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = TRANSITION_STYLE_ID;
  style.textContent = `@media (prefers-reduced-motion: no-preference){:root[${TRANSITION_ATTRIBUTE}]{transition:${transitionDeclarations}}}`;
  document.head.appendChild(style);
}

function isDescendantColorTransition(name: string): boolean {
  return (
    name === 'color' ||
    name === 'fill' ||
    name === 'stroke' ||
    name.endsWith('-color') ||
    name === '--tw-gradient-from' ||
    name === '--tw-gradient-via' ||
    name === '--tw-gradient-to'
  );
}

function installFadeGuards(document: Document): void {
  const view = document.defaultView;
  if (!view || typeof view.requestAnimationFrame !== 'function') return;
  const root = document.documentElement;
  let cleanupFrame = 0;
  let fallbackTimer = 0;
  let cancellationFrame = 0;
  let fadeGeneration = 0;
  let lastClass = root.getAttribute('class');
  let lastPalette = root.getAttribute('data-color-theme');
  const descendantTransitionElements = new Set<Element>();
  const cancelColorTransitions = (element: Element) => {
    for (const animation of element.getAnimations({ subtree: false })) {
      if (
        isDescendantColorTransition(
          (animation as { transitionProperty?: string }).transitionProperty ?? '',
        )
      ) {
        animation.cancel();
      }
    }
  };
  const cancelRunningDescendantColorTransitions = () => {
    if (typeof document.getAnimations !== 'function') return;
    for (const animation of document.getAnimations()) {
      const effect = animation.effect;
      const element = effect && 'target' in effect ? effect.target : null;
      if (element === root || !(element instanceof view.Element)) continue;
      if (
        isDescendantColorTransition(
          (animation as { transitionProperty?: string }).transitionProperty ?? '',
        )
      ) {
        animation.cancel();
      }
    }
  };
  const scheduleDescendantCancellation = () => {
    if (cancellationFrame) return;
    cancellationFrame = view.requestAnimationFrame(() => {
      cancellationFrame = 0;
      for (const element of descendantTransitionElements) cancelColorTransitions(element);
      if (root.hasAttribute(TRANSITION_FADING_ATTRIBUTE)) scheduleDescendantCancellation();
    });
  };
  const clearIfSettled = (generation: number) => {
    cleanupFrame = 0;
    if (generation !== fadeGeneration) return;
    if (document.hidden || !themeColorTransitionsActive(document)) {
      root.removeAttribute(TRANSITION_FADING_ATTRIBUTE);
      descendantTransitionElements.clear();
      return;
    }
    scheduleCleanup(generation);
  };
  const scheduleCleanup = (generation: number) => {
    cleanupFrame = view.requestAnimationFrame(() => clearIfSettled(generation));
  };
  const markFading = () => {
    const nextClass = root.getAttribute('class');
    const nextPalette = root.getAttribute('data-color-theme');
    if (nextClass === lastClass && nextPalette === lastPalette) return;
    lastClass = nextClass;
    lastPalette = nextPalette;
    fadeGeneration += 1;
    const generation = fadeGeneration;
    if (fallbackTimer) {
      view.clearTimeout(fallbackTimer);
      fallbackTimer = 0;
    }
    root.setAttribute(TRANSITION_FADING_ATTRIBUTE, '');
    cancelRunningDescendantColorTransitions();
    if (!themeColorTransitionsActive(document)) {
      root.removeAttribute(TRANSITION_FADING_ATTRIBUTE);
      descendantTransitionElements.clear();
      return;
    }
    fallbackTimer = view.setTimeout(() => {
      fallbackTimer = 0;
      clearIfSettled(generation);
    }, TRANSITION_DURATION_MS);
    scheduleDescendantCancellation();
  };
  new view.MutationObserver(markFading).observe(root, {
    attributes: true,
    attributeFilter: ['class', 'data-color-theme'],
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    fadeGeneration += 1;
    if (fallbackTimer) view.clearTimeout(fallbackTimer);
    if (cleanupFrame) view.cancelAnimationFrame(cleanupFrame);
    root.removeAttribute(TRANSITION_FADING_ATTRIBUTE);
    descendantTransitionElements.clear();
  });
  document.addEventListener(
    'transitionrun',
    (event) => {
      if (event.target === root || !root.hasAttribute(TRANSITION_FADING_ATTRIBUTE)) return;
      if (!isDescendantColorTransition(event.propertyName)) return;
      const element = event.target;
      if (!(element instanceof view.Element)) return;
      descendantTransitionElements.add(element);
      cancelColorTransitions(element);
      scheduleDescendantCancellation();
    },
    true,
  );
}

export function armThemeColorTransitions(document: Document = window.document): boolean {
  if (armedDocuments.has(document) || document.documentElement.hasAttribute(TRANSITION_ATTRIBUTE)) {
    armedDocuments.add(document);
    return true;
  }
  if (!registerProperties(document)) return false;
  installTransitionStyle(document);
  installFadeGuards(document);
  document.documentElement.setAttribute(TRANSITION_ATTRIBUTE, '');
  armedDocuments.add(document);
  return true;
}

export function useThemeColorTransitions(ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    const tryArm = () => {
      try {
        armThemeColorTransitions();
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: 'theme-color-transitions-arm-failed',
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    };
    if (typeof requestAnimationFrame !== 'function') {
      tryArm();
      return;
    }
    const frame = requestAnimationFrame(tryArm);
    return () => cancelAnimationFrame(frame);
  }, [ready]);
}

export function themeColorTransitionsActive(document: Document = window.document): boolean {
  const root = document.documentElement;
  if (typeof root.getAnimations !== 'function') return false;
  return root
    .getAnimations({ subtree: false })
    .some((animation) =>
      isThemeColorProperty((animation as { transitionProperty?: string }).transitionProperty ?? ''),
    );
}
