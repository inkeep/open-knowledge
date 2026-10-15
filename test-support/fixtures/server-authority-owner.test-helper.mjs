import { watchCliOwner } from '../../packages/cli/src/commands/cli-owner.test-helper.ts';

watchCliOwner({ connected: process.connected, once: process.once.bind(process) }, () =>
  process.exit(1),
);
