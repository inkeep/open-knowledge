import { type BootServerOptions, bootServer as boot } from '../packages/server/src/boot.ts';
import { testAuthorityRegistryPath } from './server-authority-registry.test-helper.ts';

export type { BootedServer, BootServerOptions } from '../packages/server/src/boot.ts';

export function bootServer(options: BootServerOptions) {
  return boot({
    ...options,
    authorityRegistryPath: options.authorityRegistryPath ?? testAuthorityRegistryPath,
  });
}
