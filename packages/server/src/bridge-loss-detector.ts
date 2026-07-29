/**
 * Content-loss detection for the Y.Text→XmlFragment (Observer B) direction.
 *
 * The paired agent-undo derive rebuilds the fragment from the post-undo Y.Text
 * (`deriveFragmentFromYtext`). When the pre-derive fragment held authored
 * content the authoritative Y.Text lacked — an un-propagated WYSIWYG keystroke —
 * the rebuild discards it. This module observes that class at the bridge
 * boundary: it computes a content-loss verdict, writes a `bridge-derive-loss`
 * checkpoint of the pre-derive fragment (the restore anchor), and emits a
 * content-free `detector-trip` ring event.
 *
 * This is a DETECTION site, not a recovery: the derive still proceeds
 * (Y.Text-is-truth). The checkpoint keeps the discarded content restorable
 * through the timeline floor; the ring event makes the loss observable.
 */

import { findDroppedContent, fnv1aDigest, pendingContentLines } from '@inkeep/open-knowledge-core';
import { getLogger } from './logger.ts';
import { LOSS_EVENT_DETECTOR_TRIP, type LossCaptureRing } from './loss-capture.ts';
import { type ShadowHandle, saveInMemoryCheckpoint } from './shadow-repo.ts';

const log = getLogger('bridge-loss-detector');
const checkpointLog = getLogger('checkpoint');

/**
 * The Observer-A (XmlFragment→Y.Text) apply post-condition verdict: substantive
 * content the fragment's intended markdown (`intendedMd`) holds that the applied
 * Y.Text (`appliedYText`) dropped. Returns the dropped substrings; empty means
 * nothing was lost.
 *
 * The comparison runs in normalized space so a raw-vs-canonical form difference
 * a byte-preserving splice legitimately leaves in Y.Text (`__foo__` vs
 * `**foo**`, an un-padded GFM table) is never read as a loss. `normIntended` is
 * the drain's already-computed `normalizeBridge(md)`, reused so the only extra
 * cost is one normalize of the applied bytes — and both a byte-identical apply
 * and a normalize-equal apply short-circuit before the segment diff.
 */
export function detectApplyArmDrop(
  intendedMd: string,
  normIntended: string,
  appliedYText: string,
  /**
   * `normalizeBridge(appliedYText)`. Supplied by the caller because the drain
   * already needs it for its settlement check — computing it here too would pay
   * a second O(doc bytes) pass on the per-keystroke path.
   */
  normApplied: string,
): string[] {
  if (intendedMd === appliedYText) return [];
  if (normApplied === normIntended) return [];
  return findDroppedContent(normIntended, normApplied, normApplied);
}

/**
 * The representations a derive post-condition compares. All are canonical
 * markdown BODIES (frontmatter-stripped, run through the same serializer) so
 * the comparison is normalization-sound: a user-form difference the serializer
 * canonicalizes identically on both sides (`__foo__` → `**foo**`) never reads
 * as a loss. Comparing the canonical fragment against RAW Y.Text bytes would
 * false-positive on exactly that class, so both twins are canonical.
 */
export interface DeriveLossObservation {
  /** Serialization of the fragment BEFORE the rebuild — the at-risk content. */
  pendingBody: string;
  /**
   * Canonical serialization of the Y.Text BEFORE the operation that preceded
   * this derive (for agent-undo, the pre-undo Y.Text). This is the shared
   * ancestor: content the pre-derive fragment holds that this baseline ALSO
   * held was propagated content the operation legitimately removed (the undo's
   * own effect) — NOT a loss. Only fragment content ABSENT from this baseline
   * (a keystroke that never reached Y.Text) can be a silent loss. Comparing
   * against the post-op Y.Text instead would misread every intended undo as a
   * loss.
   */
  baselineBody: string;
  /**
   * Canonical serialization of the post-op Y.Text, obtained by re-serializing
   * the parse result directly (independent of the live fragment).
   */
  ytextDerivedBody: string;
  /** Serialization of the live fragment AFTER the rebuild (the second twin). */
  rebuiltBody: string;
  /**
   * The full pre-derive document (frontmatter + `pendingBody`) written as the
   * checkpoint's restore payload — the state a user recovers to.
   */
  restorePayload: string;
}

/**
 * Producer + consumer twin on independent representations. Returns the dropped
 * content substrings; empty means nothing was lost.
 *
 * At-risk content = content the pre-derive fragment holds that the pre-op
 * `baselineBody` did NOT (a never-propagated keystroke). A drop is that at-risk
 * content also missing from the rebuilt fragment (producer twin) or the post-op
 * ytext-derived form (consumer twin):
 *
 *  - producer (live-fragment side): the live fragment after the rebuild.
 *  - consumer (ytext-derived side): the ytext parsed and re-serialized directly
 *    — a derivation independent of the live fragment.
 *
 * All three are canonical, so the comparison is normalization-sound. The union
 * is taken so a defect in either derivation is caught by the independent twin.
 */
export function detectDeriveLoss(obs: DeriveLossObservation): string[] {
  const producer = findDroppedContent(obs.pendingBody, obs.baselineBody, obs.rebuiltBody);
  const consumer = findDroppedContent(obs.pendingBody, obs.baselineBody, obs.ytextDerivedBody);
  if (consumer.length === 0) return producer;
  const merged = [...producer];
  const seen = new Set(producer);
  for (const seg of consumer) {
    if (!seen.has(seg)) {
      seen.add(seg);
      merged.push(seg);
    }
  }
  return merged;
}

/**
 * The paired-intake loss floor: the union of the substring-drop verdict and the
 * witness-aware line predicate, evaluated on the same three canonical bodies.
 *
 * The two catch different shapes, so neither alone is the floor:
 *
 *  - `detectDeriveLoss` diffs at the substring level. It sees a mid-paragraph
 *    deletion the "fragment holds more" line predicate cannot express, but its
 *    inserted-segment filter drops a short intra-line delta that coincidentally
 *    appears elsewhere in the applied bytes (the customer `bod`→`body.` shape).
 *  - `pendingContentLines` keys on whole raw lines. It flags exactly that
 *    intra-line stomp — the changed line is a distinct raw key present in
 *    neither the target derivation nor the pre-operation baseline — but keys on
 *    lines, so it cannot report a sub-line loss the substring diff catches.
 *
 * The line predicate's witness leg is `baselineBody` (the pre-operation Y.Text):
 * a line the fragment shares with that ancestor was propagated content the
 * operation legitimately removed, never a never-propagated keystroke, so it is
 * excluded. The union is deduplicated but not deep-merged: the two produce
 * different string forms (trimmed segments vs raw lines), which only affects the
 * content-free digest's granularity, never the trip decision.
 */
export function detectPairedIntakeLoss(obs: DeriveLossObservation): string[] {
  const dropped = detectDeriveLoss(obs);
  const pending = pendingContentLines(obs.pendingBody, obs.ytextDerivedBody, obs.baselineBody);
  if (pending.length === 0) return dropped;
  const seen = new Set(dropped);
  const merged = [...dropped];
  for (const line of pending) {
    if (!seen.has(line)) {
      seen.add(line);
      merged.push(line);
    }
  }
  return merged;
}

/**
 * What a paired-derive caller wires into `deriveFragmentFromYtext` to enable the
 * post-condition. The caller supplies the PRE-operation Y.Text so intended
 * removals are excluded from the loss verdict; the primitive canonicalizes it.
 */
export interface DeriveLossDetectOptions {
  /** Invoked with the canonical before/after representations after the rebuild. */
  report: (obs: DeriveLossObservation) => void;
  /**
   * Full Y.Text (frontmatter + body) BEFORE the operation that preceded this
   * derive — for agent-undo, the pre-undo Y.Text captured before `um.undo()`.
   */
  baselineFullMd: string;
}

/**
 * Ring `site` values for the derive-loss reporter — one per paired vector whose
 * ytext→fragment rebuild can discard pending fragment content. Distinguishes
 * the ring events so a bundle can tell an agent-undo loss from a file-watcher
 * overwrite from an agent-write overwrite.
 */
export const DERIVE_LOSS_SITE_AGENT_UNDO = 'agent-undo-derive';
export const DERIVE_LOSS_SITE_FILE_WATCHER_INTAKE = 'file-watcher-intake';
export const DERIVE_LOSS_SITE_AGENT_WRITE_INTAKE = 'agent-write-intake';

/** A pre-bound derive-loss observer the caller invokes after a paired derive. */
export type BridgeDeriveLossReporter = (
  docName: string,
  obs: DeriveLossObservation,
  writerId?: string | null,
  /** Which paired vector's derive ran — see the `DERIVE_LOSS_SITE_*` constants. */
  site?: string,
) => void;

export interface BridgeDeriveLossReporterDeps {
  /** Live shadow handle, or undefined when no shadow is configured. */
  shadow: () => ShadowHandle | undefined;
  /** Content-free loss ring; omitted when loss capture is disabled. */
  ring?: Pick<LossCaptureRing, 'record'>;
  /** Current project branch for the `refs/checkpoints/<branch>/*` namespace. */
  getBranch: () => string;
  /** Content root prefix for the checkpoint tree path. */
  contentRoot: string;
}

/**
 * Build a reporter closed over the shadow + ring. The reporter runs the
 * paired-intake loss floor (the substring twin unioned with the line predicate)
 * and, on loss, writes a `bridge-derive-loss` checkpoint (fire-and-forget) plus
 * a `detector-trip` ring event carrying the resolved checkpoint sha. Never
 * throws — a diagnostic failure must never break the undo path.
 */
export function createBridgeDeriveLossReporter(
  deps: BridgeDeriveLossReporterDeps,
): BridgeDeriveLossReporter {
  return (docName, obs, writerId = null, site = DERIVE_LOSS_SITE_AGENT_UNDO) => {
    const dropped = detectPairedIntakeLoss(obs);
    if (dropped.length === 0) return;
    const lostLen = dropped.reduce((n, s) => n + s.length, 0);
    const digest = fnv1aDigest(dropped.join('\n'));
    const shadow = deps.shadow();
    if (!shadow) {
      void deps.ring?.record({
        event: LOSS_EVENT_DETECTOR_TRIP,
        docName,
        writerId,
        direction: 'b',
        site,
        lostLen,
        digest,
      });
      return;
    }
    const branch = deps.getBranch();
    const contentRoot = deps.contentRoot;
    queueMicrotask(() => {
      saveInMemoryCheckpoint(shadow, contentRoot, {
        kind: 'bridge-derive-loss',
        docName,
        contents: obs.restorePayload,
        label: `Before ${site} content-loss @ ${new Date().toISOString()}`,
        branch,
        metadata: { lostSubstrings: dropped },
      })
        .then((sha) => {
          void deps.ring?.record({
            event: LOSS_EVENT_DETECTOR_TRIP,
            docName,
            writerId,
            direction: 'b',
            site,
            lostLen,
            digest,
            checkpointSha: sha,
          });
          console.warn(
            JSON.stringify({
              event: 'bridge-derive-loss-checkpoint-created',
              docName,
              sha,
              kind: 'bridge-derive-loss',
              site,
              timestamp: new Date().toISOString(),
            }),
          );
        })
        .catch((checkpointErr: unknown) => {
          const e =
            checkpointErr instanceof Error ? checkpointErr : new Error(String(checkpointErr));
          log.warn({ docName, err: e }, '[bridge-derive-loss] checkpoint write failed');
          checkpointLog.warn(
            { err: e, 'doc.name': docName, branch, kind: 'bridge-derive-loss' },
            'checkpoint write failed',
          );
        });
    });
  };
}
