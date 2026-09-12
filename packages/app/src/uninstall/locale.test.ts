import { afterEach, expect, test, vi } from 'vitest';
import { activateUninstallLocale } from './locale';

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  apply: vi.fn(),
}));
vi.mock('@/lib/activate-locale', () => ({ dynamicActivate: mocks.activate }));
vi.mock('@/lib/use-apply-config-language', async () => ({
  ...(await vi.importActual<typeof import('@/lib/use-apply-config-language')>(
    '@/lib/use-apply-config-language',
  )),
  applyLanguageToDom: mocks.apply,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

test('catalog load failure resolves so the English fallback can mount', async () => {
  vi.stubGlobal('window', { location: { search: '?locale=es' } });
  const failure = new Error('catalog unavailable');
  mocks.activate.mockRejectedValue(failure);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(activateUninstallLocale()).resolves.toBeUndefined();
  expect(mocks.activate).toHaveBeenCalledWith('es');
  expect(mocks.apply).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(
    'Could not load the uninstall language; using English.',
    failure,
  );
});

test('activates the handed-off language before applying its direction', async () => {
  vi.stubGlobal('window', { location: { search: '?locale=es' } });
  await activateUninstallLocale();
  expect(mocks.activate).toHaveBeenCalledWith('es');
  expect(mocks.apply).toHaveBeenCalledWith({ preference: 'es', locale: 'es' });
});
