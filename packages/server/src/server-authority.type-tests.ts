import { ServerAuthorityRegistryError } from './server-authority.ts';

new ServerAuthorityRegistryError('unavailable', undefined, new Error());
new ServerAuthorityRegistryError('invalid-data', '/registry.sqlite', new Error());
// @ts-expect-error -- Only an unresolved OS-account home can lack a registry path
new ServerAuthorityRegistryError('invalid-data', undefined, new Error());
