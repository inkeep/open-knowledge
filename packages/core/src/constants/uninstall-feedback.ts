export const UNINSTALL_FEEDBACK_REASONS = Object.freeze([
  { value: 'workflow-fit', label: "It didn't fit into my workflow" },
  { value: 'missing-feature', label: 'It was missing a feature I needed' },
  { value: 'hard-to-start', label: 'It was too hard to set up or get started' },
  { value: 'unreliable', label: 'Bugs, crashes, or it felt unreliable' },
  { value: 'switched-tool', label: "I'm switching to another tool" },
  { value: 'one-off', label: 'It was a trial or one-off project' },
  { value: 'other', label: 'Something else' },
] as const satisfies readonly { readonly value: string; readonly label: string }[]);

export const UNINSTALL_FEEDBACK_NOTE_MAX_LEN = 10_000;
export const UNINSTALL_FEEDBACK_EMAIL_MAX_LEN = 320;

type UninstallFeedbackReasonOption = (typeof UNINSTALL_FEEDBACK_REASONS)[number];

export type UninstallFeedbackReason = UninstallFeedbackReasonOption['value'];

const UNINSTALL_FEEDBACK_REASON_VALUES: ReadonlySet<unknown> = new Set(
  UNINSTALL_FEEDBACK_REASONS.map((option) => option.value),
);

export function isUninstallFeedbackReason(value: unknown): value is UninstallFeedbackReason {
  return UNINSTALL_FEEDBACK_REASON_VALUES.has(value);
}
