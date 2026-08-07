/**
 * Best-effort detection of agent modes that let the agent act without asking.
 *
 * ACP hands the client an opaque `{id, name}` mode list with no "affects
 * permissions" flag, so OK cannot know what a mode does. What it CAN do is
 * recognise the vocabulary the common harnesses use for their permissive modes
 * — Claude Code's `bypassPermissions` / `acceptEdits`, Gemini's YOLO, Codex's
 * full-auto and danger-full-access, and the auto-approve / skip-permissions
 * naming everyone converges on.
 *
 * This drives a visual warning only (the amber accent on the settings trigger).
 * It never gates, blocks, or rewrites a mode, so the failure modes are mild in
 * both directions: a miss loses a hint, a false positive shows one too many.
 * Deliberately biased toward matching — an unflagged bypass mode is the worse
 * error — but not so loose that ordinary modes (`plan`, `ask`, `architect`,
 * `code`, `default`) trip it.
 */

/**
 * Matched against the id and name with everything but letters removed, so
 * `accept-edits`, `acceptEdits`, and "Accept Edits" all reduce to
 * `acceptedits`. Keep the alternatives letters-only for the same reason.
 *
 * The first group is what the adapters in the ACP registry actually advertise
 * over `session/new` — read out of the shipped adapters, not from their CLI
 * flags, which differ (Codex's mode id is `agent-full-access`; the
 * `danger-full-access` you see in its docs is the sandbox policy behind it):
 *
 *   claude-agent-acp  default · plan · acceptEdits · bypassPermissions
 *   codex-acp         read-only · agent · agent-full-access
 *   gemini-cli        default · plan · auto_edit · yolo
 *   cursor-agent      agent · plan · ask                (none permissive)
 *   goose             auto · approve · smart_approve · chat
 *   pi-acp            off · minimal · … · xhigh         (see note below)
 *
 * The second group is naming seen in these tools' flags and elsewhere in their
 * binaries (opencode carries `unrestricted` / `autoApprove` / `dangerously`,
 * amp carries `dangerously`) but not yet observed as a mode id. Cheap to
 * carry: matching one costs a dot the user can ignore.
 *
 * `agent` must never be added — Codex and Cursor both call their ordinary
 * mode that, so it would flag what almost everyone runs. `smart_approve` is
 * likewise left alone: it still prompts for the risky operations.
 *
 * Not every agent uses modes for permissions at all — pi-acp exposes reasoning
 * effort through the same surface. Matching on permission vocabulary rather
 * than on "is a non-default mode" is what keeps those quiet.
 */
const PERMISSIVE = new RegExp(
  [
    // Observed in shipped adapters.
    'bypass', // claude-agent-acp `bypassPermissions`
    'acceptedits', // claude-agent-acp `acceptEdits`
    'fullaccess', // codex-acp `agent-full-access`
    'autoedit', // gemini-cli `auto_edit`
    'yolo', // gemini-cli `yolo`
    // Speculative: seen in these tools' flags/docs, not (yet) as mode ids.
    'danger', // `--dangerously-skip-permissions`, codex `danger-full-access`
    'fullauto', // codex `--full-auto`
    'autoaccept',
    'autoapprove',
    'autorun',
    'skippermission',
    'noconfirm',
    'noprompt',
    'unrestricted',
    'allowall',
  ].join('|'),
);

/**
 * Words that mean "no approval" as a WHOLE mode, but are too common to match
 * as a substring: goose names its full-autonomy mode exactly `auto`, while
 * `auto` inside a longer word says nothing on its own (an "Autocomplete" mode
 * is not a permission grant). The specific `auto*` compounds that DO carry the
 * meaning — `auto_edit`, `autoApprove` — are in `PERMISSIVE` above.
 */
const PERMISSIVE_EXACT = new Set(['auto']);

/** Letters only, lowercased — separators and casing vary per harness. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * True when a mode's id or name reads as "act without asking". See the module
 * header for why this is a hint rather than a guarantee.
 */
export function isPermissiveMode(mode: { id: string; name?: string }): boolean {
  const id = normalize(mode.id);
  const name = normalize(mode.name ?? '');
  if (PERMISSIVE_EXACT.has(id) || PERMISSIVE_EXACT.has(name)) return true;
  return PERMISSIVE.test(id) || PERMISSIVE.test(name);
}
