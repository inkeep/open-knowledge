/**
 * The churn-survey reasons offered when someone uninstalls OpenKnowledge —
 * shared verbatim by the desktop uninstall window and the `ok uninstall` CLI
 * prompt so the two surfaces can never drift apart.
 *
 * `value` is the contract: it travels to `/api/feedback` inside the opaque
 * `reasons` array and is what churn tickets are grouped by, so a slug edit or a
 * reorder silently re-buckets everything already filed. `label` is display-only
 * and free to reword.
 *
 * Plain English, not Lingui — neither consumer (Electron main, CLI) is
 * localization-wired.
 */
export const UNINSTALL_FEEDBACK_REASONS = Object.freeze([
  { value: 'workflow-fit', label: "It didn't fit into my workflow" },
  { value: 'missing-feature', label: 'It was missing a feature I needed' },
  { value: 'hard-to-start', label: 'It was too hard to set up or get started' },
  { value: 'unreliable', label: 'Bugs, crashes, or it felt unreliable' },
  { value: 'switched-tool', label: "I'm switching to another tool" },
  { value: 'one-off', label: 'It was a trial or one-off project' },
  { value: 'other', label: 'Something else' },
] as const satisfies readonly { readonly value: string; readonly label: string }[]);

/** A single offered reason, as rendered by the desktop window and CLI prompt. */
type UninstallFeedbackReasonOption = (typeof UNINSTALL_FEEDBACK_REASONS)[number];

/** The slug half of the taxonomy — what actually goes on the wire. */
export type UninstallFeedbackReason = UninstallFeedbackReasonOption['value'];

const UNINSTALL_FEEDBACK_REASON_VALUES: ReadonlySet<unknown> = new Set(
  UNINSTALL_FEEDBACK_REASONS.map((option) => option.value),
);

/**
 * Narrow an inbound slug to the taxonomy. The desktop window hands its answers
 * back to the main process through a navigation URL, so the slug arrives as an
 * arbitrary string and has to be re-checked before it can be filed.
 */
export function isUninstallFeedbackReason(value: unknown): value is UninstallFeedbackReason {
  return UNINSTALL_FEEDBACK_REASON_VALUES.has(value);
}
