export const DOM_GLOBALS = [
  'window',
  'document',
  'Storage',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'HTMLElement',
] as const;

export type DomGlobal = (typeof DOM_GLOBALS)[number];

export function installedDomGlobals(scope: object = globalThis): DomGlobal[] {
  return DOM_GLOBALS.filter((name) => name in scope);
}

export function refuseDomGlobals(moment: string, scope: object = globalThis): void {
  const installed = installedDomGlobals(scope);
  if (installed.length === 0) return;
  throw new Error(
    `The Node destination runs without a DOM, but ${installed.join(', ')} ${installed.length === 1 ? 'is' : 'are'} defined ${moment}. ` +
      'A test that needs a DOM belongs in the browser destination (*.browser.test.ts?(x)); otherwise remove what installs it.',
  );
}
