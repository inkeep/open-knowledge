/**
 * Per-tab identity constants.
 *
 * `tabSessionId` is generated once at module load — frozen for the lifetime
 * of the browser tab. Two tabs opening the same document will have distinct
 * `tabSessionId` values but share the same `principalId` (fetched from the
 * server's principal record). This gives presence distinctness (each tab is
 * a separate cursor/awareness entry) while grouping shadow-repo writes under
 * a single `refs/wip/<branch>/<principalId>` ref.
 */

import { randomUUID } from '@inkeep/open-knowledge-core';

// `randomUUID` (not `crypto.randomUUID`) is load-bearing here: this runs at
// module load, and `crypto.randomUUID` is undefined on a plain-HTTP
// non-localhost origin (an exposed server over a tailnet/LAN IP), which would
// throw before React mounts. See randomUUID's contract.
export const tabSessionId: string = randomUUID();
