import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WEDGE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'spawn-bound-wedge.sh');

export const WEDGE_MARKER = 'spawn-bound-wedge: trap installed, blocking';

export const WEDGE_BLOCK_MS = 5_000;

export const WEDGE_BUDGET_MS = 1_000;

export const WEDGE_RETURN_CEILING_MS = 3_000;
