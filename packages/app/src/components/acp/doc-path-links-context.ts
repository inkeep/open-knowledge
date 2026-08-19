import { createContext } from 'react';

/**
 * True when the module-scoped `currentResolver` in `doc-path-links` has been
 * populated (workspace + page list resolved). `AgentMarkdown` reads this to
 * key its Streamdown so every mounted instance re-parses once when the
 * resolver flips null → ready. Provided by `ThreadView` — one derivation
 * above the transcript instead of one `useWorkspace()` per message bubble
 * (which would fire `/api/workspace` per message on web hosts).
 *
 * Default `false`: renders outside a ThreadView (test harnesses,
 * standalone AgentMarkdown mounts) get the no-resolver key, matching the
 * behavior when the resolver is not yet available.
 */
export const DocPathResolverReadyContext = createContext(false);
