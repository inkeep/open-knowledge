import { preparePrebuiltDevApp } from './prebuilt-dev-build.ts';
import {
  describeChanges,
  E2E_SERVING_ENV,
  e2eServingMode,
  PREBUILT_APP_ENV,
} from './prebuilt-serving.ts';

export default async function preparePrebuiltServing(): Promise<(() => void) | undefined> {
  if (e2eServingMode(process.env) !== 'prebuilt') return undefined;
  const app = await preparePrebuiltDevApp();
  const { decision } = app;
  const how = decision.serve
    ? 'serving the build already made for these inputs'
    : !app.built
      ? 'serving the build another run made for these inputs while this run was building'
      : decision.reason === 'missing'
        ? 'built it, since nothing was built for these inputs'
        : `rebuilt it, because ${describeChanges(decision)} changed since the previous build`;
  console.log(`[e2e ${E2E_SERVING_ENV}=prebuilt] ${app.outputDir}: ${how}`);
  process.env[PREBUILT_APP_ENV] = app.outputDir;
  return app.use.release;
}
