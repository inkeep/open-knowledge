import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CONTEXT_SEPARATOR = '\u0004';

async function loadLingui(appRoot) {
  const requireFromApp = createRequire(join(appRoot, 'package.json'));
  const requireFromCli = createRequire(requireFromApp.resolve('@lingui/cli'));
  const [api, conf] = await Promise.all([
    import(pathToFileURL(requireFromApp.resolve('@lingui/cli/api')).href),
    import(pathToFileURL(requireFromCli.resolve('@lingui/conf')).href),
  ]);
  return { api, conf };
}

async function collect(appRoot, files) {
  const { api, conf } = await loadLingui(appRoot);
  const configPath = join(appRoot, 'lingui.config.ts');
  const config = conf.getConfig({ cwd: appRoot, configPath });
  if (resolve(config.rootDir) !== appRoot) {
    throw new Error(`lingui loaded a config rooted at ${config.rootDir}, not ${configPath}`);
  }
  const anchored = (patterns) =>
    [patterns].flat().map((pattern) => (isAbsolute(pattern) ? pattern : join(appRoot, pattern)));
  const [catalog] = await api.getCatalogs({
    ...config,
    catalogs: config.catalogs.map((catalogConfig) => ({
      ...catalogConfig,
      include: anchored(catalogConfig.include),
      exclude: anchored(catalogConfig.exclude ?? []),
    })),
  });
  const messages = await catalog.collect({ files });
  if (messages === undefined) {
    throw new Error(`lingui could not extract the messages under ${appRoot}`);
  }
  return Object.entries(messages).map(([id, message]) => ({
    id,
    message: message.message,
    context: message.context,
    origins: [
      ...new Set(
        message.origin.map(([file]) =>
          relative(appRoot, resolve(config.rootDir, file)).replaceAll('\\', '/'),
        ),
      ),
    ],
  }));
}

export function extractedMessages(appRoot, files) {
  const fileList = [...files];
  if (fileList.length === 0) return Promise.resolve([]);
  return collect(resolve(appRoot), fileList);
}

export async function messageOrigins(appRoot, files) {
  const origins = new Map();
  const add = (key, paths) => {
    const known = origins.get(key);
    if (known === undefined) origins.set(key, new Set(paths));
    else for (const path of paths) known.add(path);
  };
  for (const { id, message, context, origins: paths } of await extractedMessages(appRoot, files)) {
    for (const key of new Set([id, message ?? id])) {
      add(context === undefined ? key : `${context}${CONTEXT_SEPARATOR}${key}`, paths);
    }
  }
  return origins;
}
