import { hostFacts } from './file-bridge';

const SERVED_FILESYSTEM_PREFIX = '/@fs/';

export function fileURLToPath(url: string | URL): string {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  const pathname = decodeURIComponent(parsed.pathname);
  if (parsed.protocol === 'file:') return pathname;
  if (parsed.origin !== location.origin) {
    throw new TypeError(
      `The URL must be of scheme file or served by this test server: ${parsed.href}`,
    );
  }
  if (pathname.startsWith(SERVED_FILESYSTEM_PREFIX)) {
    return pathname.slice(SERVED_FILESYSTEM_PREFIX.length - 1);
  }
  const { cwd } = hostFacts();
  return pathname.startsWith(`${cwd}/`) ? pathname : `${cwd}${pathname}`;
}

export function pathToFileURL(path: string): URL {
  return new URL(`file://${encodeURI(path)}`);
}

const EngineURL = globalThis.URL;
const EngineURLSearchParams = globalThis.URLSearchParams;

export { EngineURL as URL, EngineURLSearchParams as URLSearchParams };

export default {
  fileURLToPath,
  pathToFileURL,
  URL: EngineURL,
  URLSearchParams: EngineURLSearchParams,
};
