import sirv from 'sirv';
import type { Connect } from 'vite';

export type AssetRouting =
  | { readonly kind: 'dev-server' }
  | { readonly kind: 'prebuilt'; readonly bundleDir: string };

function servedByViteDevServer(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  const queryStart = url.indexOf('?');
  const query = queryStart >= 0 ? url.slice(queryStart) : '';
  const params = query ? new URLSearchParams(query) : null;
  return (
    path.startsWith('/@vite/') ||
    path.startsWith('/@fs/') ||
    path.startsWith('/@id/') ||
    path === '/@react-refresh' ||
    path.startsWith('/node_modules/') ||
    path.startsWith('/src/') ||
    path === '/favicon.svg' ||
    path === '/assets/preview-frame.html' ||
    params?.has('import') === true ||
    params?.has('html-proxy') === true
  );
}

// WARN: these are the bundle prefixes packages/server/src/http/content-dispatch.ts serves shell-first; keep them in step.
const BUNDLE_FIRST_PREFIXES = ['/assets/', '/excalidraw-assets/'] as const;

export function routeAssets(
  routing: AssetRouting,
  assetMiddleware: Connect.NextHandleFunction,
): Connect.NextHandleFunction {
  if (routing.kind === 'dev-server') {
    return (req, res, next) =>
      servedByViteDevServer(req.url ?? '') ? next() : assetMiddleware(req, res, next);
  }
  const bundle = sirv(routing.bundleDir, { dev: true, etag: true });
  return (req, res, next) => {
    const path = req.url?.split('?')[0] ?? '';
    if (path === '/favicon.svg') return next();
    if (!BUNDLE_FIRST_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      return assetMiddleware(req, res, next);
    }
    bundle(req, res, () =>
      assetMiddleware(req, res, () => {
        res.statusCode = 404;
        res.end();
      }),
    );
  };
}
