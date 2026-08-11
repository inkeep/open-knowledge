/**
 * Freshness triggers 3, 4 and 5 of the shared validation store.
 *
 * Trigger 3 — when a doc's bytes reach disk (CC1 `disk-ack`, relayed as the
 * doc-persisted event), re-validate JUST that doc via the scoped audit and
 * patch its store entry. This heals the silent false-negative where an agent
 * writes a broken link (or a lint problem) into a document nobody has open —
 * its tree tint updates without a whole-project walk. Debounced per doc:
 * persistence flushes ack in bursts during active writing; one trailing
 * re-validate per doc per burst is enough for a tree tint.
 *
 * Trigger 4 — when the world every entry was produced against stops holding, the
 * whole plane is re-audited. Three signals qualify. A lint-config change (a plugin
 * enabled, a rule toggled, a frontmatter schema edited) invalidates the config
 * the counts were computed under; without this, enabling a plugin lights up
 * nothing until you open files one at a time, and toggling a rule off leaves its
 * counts standing. A local-targets change invalidates file/image existence
 * findings without necessarily changing the document graph. A branch switch
 * invalidates the content itself — it replaces
 * the content set wholesale in-window, with no reload to rebuild the plane, so
 * the sidebar would otherwise keep showing the previous branch's problems until
 * a config change or a per-doc write happened to trip triggers 3/4.
 *
 * Trigger 5 — once per project open, audit the plane so a project configured in
 * an earlier session is correct on arrival. Triggers 2-4 all need something to
 * HAPPEN in this session (a doc opened, a doc written, the config changed), so
 * without this the store starts empty on every launch and a KB whose problems
 * predate the session shows a bare sidebar until the user opens files one by one
 * or runs the audit by hand — the original complaint, recurring at every launch.
 *
 * Triggers 4 and 5 are the two whole-project walks, so both are kept cheap the
 * same ways: the counts-only plane rather than the enumerated one, and the server
 * coalescing concurrent identical audits into one. Trigger 4 additionally
 * debounces bursts and single-flights them across both its signals — a later
 * invalidation landing mid-walk aborts the walk it supersedes, so a config
 * change arriving just after a branch switch cannot be overwritten by the
 * branch's older, now-stale result. Trigger 5 is a run-once latch that aborts
 * only on unmount, latching once a run actually populates the store — and
 * retrying a bounded number of times when one does not, because its only other
 * retry signal is a doc count that in an ordinary reading session never moves
 * again.
 *
 * Neither trigger caps by project size, deliberately. The Problems panel's
 * on-demand audit has always walked any project uncapped, and trigger 4 does too,
 * so capping trigger 5 alone bought no protection and made the product
 * inconsistent — the same project would show a populated sidebar after a rule
 * toggle and a bare one after a reopen. A size bound, if one is ever warranted,
 * belongs in the audit engine where all three callers inherit it, not bolted onto
 * one of them. What keeps the cost tolerable here is that the desktop server
 * survives app quit (packaged builds spawn it detached — see
 * `packages/desktop/README.md`), so reopening reattaches to a live server with a
 * warm per-file cache; a genuinely cold walk happens once per server lifetime,
 * not once per launch.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import { useOptionalPageList } from '@/components/PageListContext';
import { setLinkValidationVisible } from '@/editor/link-validation-policy';
import { subscribeToLintConfigChanged } from '@/editor/lint-config-client';
import {
  AUDIT_SUPERSEDED,
  runValidationAudit,
  runValidationAuditCounts,
} from '@/editor/validation-audit-client';
import { useConfigContext } from '@/lib/config-provider';
import { filePathToDocName } from '@/lib/doc-hash';
import {
  invalidatesLocalTargetAudit,
  subscribeToBranchChanged,
  subscribeToDocPersisted,
  subscribeToDocumentsChanged,
} from '@/lib/documents-events';
import { patchDocValidationFromAudit, replaceValidationFromCounts } from '@/lib/validation-store';

const REVALIDATE_DEBOUNCE_MS = 500;

/**
 * Longer than the per-doc debounce: a rule-by-rule pass through the Settings
 * rule list emits one config-changed event per click, and each one would
 * otherwise start a whole-project walk. Long enough to coalesce deliberate
 * clicking, short enough that a single toggle still feels immediate. Branch
 * switches share the window — they never burst, but a switch that lands during
 * a toggle pass should fold into the same walk rather than add one.
 */
const PLANE_AUDIT_DEBOUNCE_MS = 750;

/** Wait for the app's own boot work to settle before spending CPU on an audit. */
const AUDIT_ON_OPEN_DELAY_MS = 1_200;

/**
 * Attempts the on-open walk gets before giving up for the session, and the
 * first retry's delay (doubled per attempt). A doc count that never moves again
 * is the ordinary case — nothing creates or removes a document in a session
 * spent reading — so a single transient failure (the server still finishing its
 * own boot, a 500) would otherwise cost the whole session the on-open pass and
 * reinstate the bare sidebar this trigger exists to fill. Bounded rather than
 * open-ended: past a few seconds the failure is not transient, and the manual
 * audit plus triggers 3-4 still cover the session.
 */
const AUDIT_ON_OPEN_MAX_ATTEMPTS = 3;
const AUDIT_ON_OPEN_RETRY_MS = 1_500;

/**
 * DocNames the per-doc re-validate skips: reserved trees (`__system__`,
 * `__config__/…`, `__skill__/…`, `__template__/…`, `__local__/…`, `__user__/…`)
 * are not content docs, and extension-retaining Mermaid docs (`.mmd` /
 * `.mermaid`) have no markdown plane to audit.
 */
function isAuditableDocName(docName: string): boolean {
  return !docName.startsWith('__') && !/\.(mmd|mermaid)$/i.test(docName);
}

/**
 * The whole-project step shared by triggers 4 and 5: audit the counts-only plane
 * and replace the store with it. A failed or superseded run leaves the previous
 * entries alone — stale beats wrongly-clean, the same call the per-doc
 * re-validate makes.
 */
async function auditProjectIntoStore(signal: AbortSignal): Promise<boolean> {
  const result = await runValidationAuditCounts({ kind: 'project' }, signal);
  // A superseded walk carries no plane; the config change that superseded it
  // is the same one that schedules the replacement, so write nothing and stay
  // unlatched rather than treating it as a completed run.
  if (signal.aborted || result === null || result === AUDIT_SUPERSEDED) return false;
  replaceValidationFromCounts(result.files);
  return true;
}

export function ValidationFreshness() {
  // The per-doc re-validate exists to keep the file tree's indicators fresh;
  // when the project turns those off (`validation.fileTreeIndicators`), skip
  // the background work entirely instead of writing to a store nothing reads.
  const { merged } = useConfigContext();
  const indicatorsEnabled = merged?.validation?.fileTreeIndicators !== false;
  const linksVisible = merged?.validation?.links !== 'off';
  // This subscriber mounts before the editors; update before paint so a
  // project configured with "Don't show" never flashes broken-link styling.
  useLayoutEffect(() => setLinkValidationVisible(linksVisible), [linksVisible]);
  // Doc count for the on-open budget, read off the list the file tree already
  // loaded — so deciding whether to audit never costs a walk of its own. Optional
  // like the Problems panel's own use: absent provider (bare harness) reads as
  // "count unknown", which holds the on-open audit rather than guessing.
  const pageCount = useOptionalPageList()?.pages.size ?? 0;
  // Latches the once-per-open audit. A ref, not state: flipping it must not
  // re-render, and the page list keeps growing as docs are created.
  const ranOnOpenRef = useRef(false);

  useEffect(() => {
    if (!indicatorsEnabled) return;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let disposed = false;

    const revalidate = (docName: string) => {
      void runValidationAudit({ kind: 'doc', docName }).then((result) => {
        // A failed scoped audit (server hiccup) keeps the previous entry —
        // stale beats wrongly-clean. A superseded one keeps it for the same
        // reason: the config change that superseded it re-runs the whole plane.
        if (disposed || result === null || result === AUDIT_SUPERSEDED) return;
        const diagnostics = result.files
          .filter((file) => filePathToDocName(file.file) === docName)
          .flatMap((file) => file.diagnostics);
        patchDocValidationFromAudit(docName, diagnostics);
      });
    };

    const unsubscribe = subscribeToDocPersisted((docName) => {
      if (!isAuditableDocName(docName)) return;
      const existing = timers.get(docName);
      if (existing !== undefined) clearTimeout(existing);
      timers.set(
        docName,
        setTimeout(() => {
          timers.delete(docName);
          revalidate(docName);
        }, REVALIDATE_DEBOUNCE_MS),
      );
    });

    return () => {
      disposed = true;
      unsubscribe();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, [indicatorsEnabled]);

  // Trigger 4: re-audit the whole plane when the config or the branch changes.
  useEffect(() => {
    if (!indicatorsEnabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Single-flight: a later invalidation landing mid-walk aborts the walk in
    // progress, whose result is already stale, rather than racing it to the
    // store (last writer would otherwise win by arrival order, not recency).
    // Shared across both signals, so the two classes of invalidation order
    // against each other rather than only against themselves.
    let inFlight: AbortController | null = null;

    const runAudit = () => {
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;
      void auditProjectIntoStore(controller.signal).finally(() => {
        if (inFlight === controller) inFlight = null;
      });
    };

    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        runAudit();
      }, PLANE_AUDIT_DEBOUNCE_MS);
    };

    // Branch-changed fires only on an actual change — the first observation of a
    // branch seeds the pool without emitting — so subscribing here costs no walk
    // at boot; the on-open trigger owns that one.
    const unsubscribers = [
      subscribeToLintConfigChanged(schedule),
      subscribeToBranchChanged(schedule),
      subscribeToDocumentsChanged((channels) => {
        if (invalidatesLocalTargetAudit(channels)) schedule();
      }),
    ];

    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      if (timer !== null) clearTimeout(timer);
      inFlight?.abort();
    };
  }, [indicatorsEnabled]);

  // Trigger 5: one audit per project open, at any project size.
  useEffect(() => {
    if (!indicatorsEnabled) return;
    // The page list arrives asynchronously; a count of 0 means "not known yet",
    // not "empty project", so wait rather than auditing against nothing. The
    // count is a readiness + retry signal only — it does NOT gate on size.
    if (pageCount === 0 || ranOnOpenRef.current) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;

    const attempt = () => {
      timer = null;
      // Latch only once a run actually populates the store — never at schedule
      // time. `pageCount` is in the deps, so a doc count that shifts during the
      // settle delay (an optimistic add, a background refetch) tears this effect
      // down and aborts the run. Latching before the run would leave the
      // early-return above refusing to reschedule, stranding the sidebar empty
      // for the session.
      void auditProjectIntoStore(controller.signal).then((wrote) => {
        if (wrote) {
          ranOnOpenRef.current = true;
          return;
        }
        // Teardown, not failure: the effect is gone and rescheduling onto it
        // would outlive its own cleanup.
        if (controller.signal.aborted) return;
        failures += 1;
        if (failures >= AUDIT_ON_OPEN_MAX_ATTEMPTS) {
          // Each attempt logs its own transport failure, but nothing marks the
          // point where the plane is abandoned for the session — leaving a bare
          // sidebar that looks identical to one nothing ever tried to fill.
          console.warn('[audit] on-open audit exhausted retries; file-tree counts unavailable');
          return;
        }
        timer = setTimeout(attempt, AUDIT_ON_OPEN_RETRY_MS * 2 ** (failures - 1));
      });
    };

    timer = setTimeout(attempt, AUDIT_ON_OPEN_DELAY_MS);
    return () => {
      if (timer !== null) clearTimeout(timer);
      controller.abort();
    };
  }, [indicatorsEnabled, pageCount]);

  return null;
}
