import { pathToFileURL } from 'node:url';

const source = process.env.OK_TEST_WARM_CACHE_OWNER_LOSS_SOURCE;
if (source === undefined) throw new Error('warm-cache source is missing');
const { default: globalWarmViteCache } = await import(pathToFileURL(source).href);
await globalWarmViteCache();
