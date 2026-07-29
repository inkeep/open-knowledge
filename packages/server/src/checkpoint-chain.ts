/**
 * Resolving the checkpoint commits that anchor the consolidation chain.
 *
 * Shared by the consolidation writer (`shadow-repo.ts`, which adopts them as
 * parents) and the per-path activity reader (`content/shadow-log.ts`, which
 * walks their ancestry) so the two cannot disagree about where the chain is.
 */
import {
  isChainAnchorCheckpointKind,
  parseCheckpoint,
} from '@inkeep/open-knowledge-core/shadow-repo-layout';
import type { SimpleGit } from 'simple-git';
import { getLogger } from './logger.ts';

const log = getLogger('checkpoint-chain');

const SHA_LENGTH = 40;

/**
 * The checkpoints on `branch` that a new checkpoint must adopt so that reaping
 * an older checkpoint ref never strands the commit behind it.
 *
 * Two properties are load-bearing, and each fixes a distinct way the chain
 * used to break:
 *
 *  - **Kind-filtered.** Only kinds GC cannot empty may anchor
 *    (`isChainAnchorCheckpointKind`). The silent rescue kinds are parentless
 *    root commits, so a chain routed through one reaches nothing; they are also
 *    the kinds whose metadata carries verbatim document content, which a parent
 *    edge would keep reachable past the budget that expires it.
 *  - **Every tip, not the newest.** One severed chain leaves two dangling
 *    anchors, and a single-slot parent can only ever re-attach one of them.
 *    Checkpoint dates are one-second granular, so recency cannot separate a
 *    tied pair either — this returns the whole independent set rather than
 *    fabricating an order over it.
 *
 * The independence reduction runs over the ANCHOR set alone: reachability that
 * only holds through a ref GC may reap is not reachability we can rely on.
 *
 * **Throws rather than returning `[]` when a query fails.** An empty result and
 * a failed lookup are not the same thing: `for-each-ref` over an absent
 * namespace exits 0 with no output, so `[]` means "genuinely the first
 * checkpoint" and nothing else. Swallowing a thrown query would hand the writer
 * an empty anchor set and commit exactly the severed checkpoint this module
 * exists to prevent, from any transient git failure. Callers choose their own
 * policy: the writer lets it propagate so the fold fails and retries, while a
 * read path degrades to an empty history.
 */
export async function resolveCheckpointChainAnchors(
  sg: SimpleGit,
  branch: string,
): Promise<string[]> {
  let refOutput: string;
  try {
    refOutput = await sg.raw(
      'for-each-ref',
      '--format=%(objectname)',
      `refs/checkpoints/${branch}/`,
    );
  } catch (err) {
    log.warn({ branch, err }, '[checkpoint-chain] for-each-ref failed; anchors are unknown');
    throw err;
  }

  const shas = refOutput
    .trim()
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length === SHA_LENGTH);
  if (shas.length === 0) return [];

  let logRaw: string;
  try {
    logRaw = await sg.raw('log', '--no-walk', '--format=%H%x00%B%x1e', ...shas);
  } catch (err) {
    log.warn(
      { branch, shaCount: shas.length, err },
      '[checkpoint-chain] checkpoint body read failed; anchors are unknown',
    );
    throw err;
  }

  const anchors: string[] = [];
  for (const record of logRaw.split('\x1e')) {
    const trimmed = record.trimStart();
    if (!trimmed) continue;
    const [sha = '', body = ''] = trimmed.split('\x00');
    if (sha.length !== SHA_LENGTH) continue;
    if (isChainAnchorCheckpointKind(parseCheckpoint(body)?.kind ?? null)) anchors.push(sha);
  }
  if (anchors.length <= 1) return anchors;

  try {
    // `--independent` prints the minimal subset — those not reachable from any
    // other — on stdout. The exit-code-only `--is-ancestor` cannot be used
    // here: simple-git rejects on stderr rather than branching on exit status.
    const independent = await sg.raw('merge-base', '--independent', ...anchors);
    const tips = independent
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length === SHA_LENGTH);
    return tips.length > 0 ? tips : anchors;
  } catch (err) {
    // Adopting a redundant parent is harmless; dropping a needed one destroys
    // history, so an unusable reduction falls back to the full anchor set. That
    // fallback is strictly safer than the reduction it replaces, which is why
    // this one failure does not propagate.
    log.warn(
      { branch, anchorCount: anchors.length, err },
      '[checkpoint-chain] tip reduction failed; adopting the full anchor set',
    );
    return anchors;
  }
}
