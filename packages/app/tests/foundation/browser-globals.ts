Object.defineProperty(globalThis, 'global', {
  value: globalThis,
  writable: true,
  configurable: true,
  enumerable: false,
});

Object.defineProperty(globalThis, 'localStorage', {
  value: globalThis.localStorage,
  writable: true,
  configurable: true,
  enumerable: true,
});
