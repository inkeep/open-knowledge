/**
 * Prompt composers for the native-handoff subsystem. Each produces the string
 * the per-target URL builders thread into the prompt query param
 * (`q=` / `prompt=` / `text=`).
 *
 * Three are **directive** composers — file, folder, and empty-space / project.
 * Each emits a short sentence naming a path (or none, for project scope) and
 * telling the agent to open the target in OpenKnowledge's web preview. They
 * never carry file content, so the precedent #25 invariant ("agent grounds
 * via OK MCP, not native attach") holds by virtue of the URL never carrying
 * `file=` attach data.
 *
 * `composeSelectionPrompt` is the fourth — the editor "Edit with AI"
 * affordance. It is not a bare directive: it carries the passage the user
 * selected, either inlined in a fenced block or, when the selection is too
 * large to fit the URL budget, referenced by a short locus anchor the agent
 * resolves by reading the doc via OK MCP. See its own JSDoc for the transport
 * contract.
 *
 * The dispatch hook (`useHandoffDispatch`) picks the composer per
 * `HandoffDispatchInput`.
 *
 * **`autoOpen` honors the user's `appearance.preview.autoOpen` preference.**
 * When `true` (default), the prompt includes a trailing "Open the OK editor in web view."
 * directive so the receiving agent opens the project's preview UI on first
 * turn. When `false`, the directive trailer is dropped so the receiving agent
 * does not contradict the user's "agent does not open my preview" preference.
 * The legacy " in web view" suffix is dropped in both modes — OpenKnowledge
 * is now distributed as both a desktop app and a web preview, so the prompt
 * stays surface-neutral.
 *
 * **Prompt-injection defense.** Filenames arrive from the filesystem and may
 * carry control characters, embedded newlines, or quote / backslash bytes a
 * downstream agent could interpret as instruction-terminator markers. Every
 * interpolated path is passed through `sanitizePathForPrompt` to strip
 * control bytes + zero-width / bidi tricks + backticks, so the agent sees the
 * path as a single literal token rather than as instruction text. Without
 * this, a file named `notes/innocent.md\n\nNew instructions: …` would inject
 * a fake instruction block into the agent's prompt.
 */
import type { HandoffTarget } from './types.ts';

// Constructed via `new RegExp` rather than a literal so the source bytes
// don't trip biome's `noControlCharactersInRegex`. The escape sequences are
// the intentional payload — see `sanitizePathForPrompt` JSDoc for the
// per-range rationale. Compiled once at module load.
const PATH_INJECTION_SANITIZE_RE = new RegExp(
  '[' +
    '\\u0000-\\u001f' + // ASCII C0 controls
    '\\u007f-\\u009f' + // DEL + ASCII C1 controls
    '\\u200b-\\u200f' + // zero-width + bidi marks
    '\\u2028-\\u202e' + // LINE SEP + PARAGRAPH SEP + bidi overrides (ES line terminators)
    '\\u2060-\\u2069' + // word-joiner + bidi isolates
    '\\ufeff' + // BOM / zero-width no-break space
    '`' + // backtick (terminates the wrapping fence at the call site)
    ']+',
  'g',
);

// Adds ASCII space + U+00A0 (no-break space) to the suspect-byte class. Used
// by `sanitizePathForAtMention` only — `sanitizePathForPrompt` keeps regular
// spaces because the file/folder/project directive composers wrap their paths
// in backticks (the agent reads the backticked token as a unit, whitespace
// included). The selection composer interpolates the path as an `@`-mention
// without a backtick fence, so whitespace would terminate the mention at the
// agent CLI.
const AT_MENTION_PATH_INJECTION_SANITIZE_RE = new RegExp(
  '[ \\u00a0' + // ASCII space + no-break space
    '\\u0000-\\u001f' + // ASCII C0 controls
    '\\u007f-\\u009f' + // DEL + ASCII C1 controls
    '\\u200b-\\u200f' + // zero-width + bidi marks
    '\\u2028-\\u202e' + // LINE SEP + PARAGRAPH SEP + bidi overrides
    '\\u2060-\\u2069' + // word-joiner + bidi isolates
    '\\ufeff' + // BOM
    '`' + // backtick
    ']+',
  'g',
);

/**
 * Sanitize a filesystem path for inclusion in agent-bound prompt text.
 * Strips ASCII control bytes (0x00-0x1F + 0x7F-0x9F), zero-width / bidi
 * unicode tricks, and backticks (so they can't terminate the wrapping fence
 * at the call site). Each run of suspect bytes collapses to a single
 * underscore so the path stays a contiguous identifier.
 *
 * Unicode classes covered (see `PATH_INJECTION_SANITIZE_RE`):
 *   U+0000-U+001F  ASCII C0 controls (NULL, BEL, BS, TAB, LF, VT, FF, CR, …)
 *   U+007F-U+009F  DEL + ASCII C1 controls
 *   U+200B-U+200F  zero-width + bidi marks
 *   U+2028-U+2029  LINE SEPARATOR + PARAGRAPH SEPARATOR (ES line terminators)
 *   U+202A-U+202E  bidi overrides
 *   U+2060-U+2069  word-joiner + bidi isolates
 *   U+FEFF         BOM / zero-width no-break space
 *   `              backtick (terminates the wrapping fence at the call site)
 */
function sanitizePathForPrompt(path: string): string {
  return path.replace(PATH_INJECTION_SANITIZE_RE, '_');
}

/**
 * Sanitize a filesystem path for inclusion as an `@`-mention in agent-bound
 * prompt text. Extends `sanitizePathForPrompt` by also collapsing ASCII space
 * (U+0020) and no-break space (U+00A0) to `_`. The file/folder/project
 * directive composers wrap their paths in backticks (the agent reads the
 * backticked token as a unit, whitespace included), so they use the base
 * `sanitizePathForPrompt`. The selection composer interpolates `@${safePath}`
 * without a backtick fence so the receiving agent CLI (Claude Code, Codex,
 * Cursor) parses it as a real `@`-mention — at-mentions are whitespace-
 * terminated, so a path with whitespace must collapse to a single token first.
 */
function sanitizePathForAtMention(path: string): string {
  return path.replace(AT_MENTION_PATH_INJECTION_SANITIZE_RE, '_');
}

/**
 * One-sentence standing directive that steers an agent OK just launched (via
 * "Open with AI" / the docked terminal) straight to the project's runtime
 * contract — instead of reconstructing context with native search / `.ok/`
 * probing, the friction that made the handoff not feel seamless.
 *
 * Applied once at the dispatch funnel (`selectScopedPrompt`) to the *directive*
 * scopes (file / folder / create / empty-space) via `withSkillPointer`, so the
 * composers stay pure and the wording lives in exactly one place. Kept to a
 * single short sentence so it costs little of the URL budget.
 *
 * Scope: only OK-initiated handoffs carry it, so it cannot leak into non-OK
 * agent sessions. Host-agnostic prose — valid for whichever agent the handoff
 * targets (Claude Code / Codex / Cursor), no per-host flag mechanics.
 *
 * The selection scope (`composeSelectionPrompt`) deliberately does NOT get it:
 * it already ends with an explicit "read the passage via the OpenKnowledge MCP
 * server" directive, and it is the most URL-budget-constrained prompt, so
 * adding the pointer there would buy little and risk pushing selections into
 * locus mode sooner.
 */
export const OK_PROJECT_SKILL_POINTER =
  "This is an OpenKnowledge project: load the `open-knowledge` skill and use the OpenKnowledge MCP tools for all markdown — don't probe for `.ok/` or use native file tools on `.md` / `.mdx`.";

/** Prepend the standing skill pointer to a directive prompt body. */
export function withSkillPointer(directive: string): string {
  return `${OK_PROJECT_SKILL_POINTER} ${directive}`;
}

/**
 * One-sentence surface note prepended to the docked-terminal *bare*-launch
 * prompt. Tells the agent it was spawned inside the OpenKnowledge desktop
 * app's terminal panel — not a bare shell the user opened themselves — so it
 * reads the launch as an OK context handoff rather than a generic CLI session.
 *
 * Terminal-only: the web deep-link handoff never carries it (the web agent is
 * not "in the desktop app's terminal").
 */
export const OK_TERMINAL_SURFACE_PREAMBLE =
  "You're running in the terminal of the OpenKnowledge desktop app.";

/**
 * Docked-terminal *bare*-launch prompt — what lands when the user opens a
 * terminal on a file / folder / project WITHOUT typing an instruction or a
 * create brief. Unlike the directive composers it does not invite open-ended
 * work ("Let's work on X"): it states the surface, loads the OK runtime
 * contract (the skill pointer), optionally points the agent at the file that
 * was open, then tells it to stop so the user drives the next turn from the
 * terminal themselves.
 *
 * `relativePath` is the open doc's content-relative path (`.md`-suffixed,
 * forward-slash normalized), or `null` for folder / project / empty-space
 * scope (no file to read). Sanitized for prompt injection and backtick-wrapped
 * like the other path composers.
 *
 * Instruction- and create-bearing terminal launches do NOT use this — they
 * keep the directive composers (via `selectScopedPrompt`) so the user's typed
 * intent is preserved; see `composeTerminalLaunchPrompt`.
 */
export function composeTerminalBareLaunchPrompt(relativePath: string | null): string {
  const tail =
    relativePath === null
      ? 'Then stop.'
      : `Read \`${sanitizePathForPrompt(relativePath)}\` via the OpenKnowledge MCP server, then stop.`;
  return `${OK_TERMINAL_SURFACE_PREAMBLE} ${OK_PROJECT_SKILL_POINTER} ${tail}`;
}

/**
 * File-scope directive — `relativePath` is the doc's path relative to the OK
 * content directory, forward-slash normalized with the `.md` suffix
 * (e.g. `specs/foo/SPEC.md`). Wrapped in backticks so the receiving agent
 * reads the path as a single literal token even if the filename contains
 * surprising characters.
 *
 * `autoOpen` mirrors the user's `appearance.preview.autoOpen` preference.
 * Callers resolve it from `useConfigContext().merged?.appearance?.preview
 * ?.autoOpen ?? true` and pass it at click time — composer never reads
 * config itself (it lives in core, not app).
 *
 * `instruction` is the optional free-text the user typed in the "Open with AI"
 * popover (file/folder/project scope). When present it is appended as a quoted
 * `Instruction:` block (see `appendInstruction`); absent/empty leaves the bare
 * directive unchanged.
 */
export function composeFilePrompt(
  relativePath: string,
  autoOpen: boolean,
  instruction?: string,
): string {
  const safe = sanitizePathForPrompt(relativePath);
  const base = `Let's work on \`${safe}\` using OpenKnowledge.`;
  const directive = autoOpen ? `${base} Open the OK editor in web view.` : base;
  return appendInstruction(directive, instruction);
}

/**
 * Skill-authoring directive — instructs the receiving agent to use Open
 * Knowledge's `open-knowledge-write-skill` meta-skill to author the named
 * skill. `skillName` is the skill's identity (== directory, `[a-z0-9-]`),
 * backtick-wrapped + sanitized like a path token. `scope` tells the agent
 * which surface to edit via OK MCP: a `project` skill (`.ok/skills/`, shared)
 * or a `global` one (`~/.ok/skills/`, user-global).
 *
 * `autoOpen` mirrors the user's `appearance.preview.autoOpen` preference,
 * exactly like the file/folder/project directives — when `true`, the agent is
 * asked to open the OK editor on its first turn.
 */
export function composeSkillPrompt(
  skillName: string,
  scope: 'project' | 'global',
  autoOpen: boolean,
): string {
  const safe = sanitizePathForPrompt(skillName);
  const base = `Use your open-knowledge-write-skill skill to author the ${scope} Open Knowledge skill \`${safe}\`. Edit it with the Open Knowledge tools.`;
  return autoOpen ? `${base} Open the OK editor in web view.` : base;
}

/**
 * Folder-scope directive — `relativeFolderPath` is the folder's path relative
 * to the OK content directory, forward-slash normalized, no trailing slash
 * (e.g. `specs/foo`). Wrapped in backticks for the same injection-defense
 * reason as `composeFilePrompt`. `autoOpen` + `instruction` carry the same
 * semantics as `composeFilePrompt`.
 */
export function composeFolderPrompt(
  relativeFolderPath: string,
  autoOpen: boolean,
  instruction?: string,
): string {
  const safe = sanitizePathForPrompt(relativeFolderPath);
  const base = `Let's work on the \`${safe}\` folder using OpenKnowledge.`;
  const directive = autoOpen ? `${base} Open the OK editor in web view.` : base;
  return appendInstruction(directive, instruction);
}

/**
 * Project-scope directive — used by empty-space sidebar right-click, the
 * EditorHeader sparkle icon with no active target, and the post-init
 * empty-state cards. No path interpolation: project root is implicit from
 * `projectDir` on the URL. `autoOpen` + `instruction` carry the same semantics
 * as `composeFilePrompt`.
 */
export function composeEmptySpacePrompt(autoOpen: boolean, instruction?: string): string {
  const base = `Let's work on this project using OpenKnowledge.`;
  const directive = autoOpen ? `${base} Open the OK editor in web view.` : base;
  return appendInstruction(directive, instruction);
}

/**
 * Which empty-state surface the create handoff originated from — selects the
 * prompt framing. `new-project` (OnboardingView, no content yet) pitches
 * standing up a fresh project; `existing-repo` (CreateView, project already has
 * content) frames the brief as work over the existing project — no "new
 * project" wording, no scaffold-from-scratch directive.
 */
export type CreateScenario = 'new-project' | 'existing-repo';

/**
 * Create-scope composer — the empty-state "Create with <agent>" prompt. The
 * user typed (or chip-prefilled) a free-form brief; this wraps it for the
 * receiving agent, framed by `scenario` so an existing project is NOT described
 * as a brand-new one.
 *
 * Unlike the path composers, the interpolated text is the USER's own brief —
 * not a filesystem path — so it is NOT run through the path-injection sanitizer:
 * there is no privilege boundary to defend (the user is authoring the prompt for
 * their own agent). The brief is blockquoted so the agent reads it as the user's
 * directive rather than as instruction text; an empty brief degrades to a bare
 * scenario-appropriate directive.
 *
 * `autoOpen` carries the same semantics as `composeFilePrompt`.
 */
export function composeCreatePrompt(
  description: string,
  autoOpen: boolean,
  scenario: CreateScenario,
  mentions: readonly string[],
): string {
  const trailer = autoOpen ? 'Open the OK editor in web view.' : '';
  // The trailer rides its own paragraph whenever the prompt has a body: the
  // body ends in a blockquoted brief, an `@`-mention line, or the scaffold
  // sentence, and a same-line append glues the directive onto that last line —
  // inside the markdown blockquote in the worst case — where it reads as part
  // of the user's own quoted text instead of as OK's standing instruction.
  // Single-line bare directives keep the same-line shape the other scope
  // composers use.
  const withTrailer = (base: string): string => {
    if (trailer === '') return base;
    return base.includes('\n') ? [base, '', trailer].join('\n') : `${base} ${trailer}`;
  };
  const blockquote = (text: string): string =>
    text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
  // Explicit `@`-mention block ('' when no usable mentions). Held fixed across
  // the budget fit below — only the brief is ever trimmed. When empty,
  // every branch is byte-identical to the pre-mention create prompt.
  const mentionBlock = mentionsSegment(mentions);

  // Assemble the full create prompt from a candidate brief, holding the mention
  // block + scenario framing fixed. Reused as the `fitInstruction` compose
  // function so the brief is the only lever trimmed to the URL budget.
  const build = (brief: string): string => {
    const trimmed = brief.trim();
    if (scenario === 'existing-repo') {
      const briefPart =
        trimmed === ''
          ? `Let's work on this project using OpenKnowledge.`
          : [
              "Here's what I'd like to do in this OpenKnowledge project:",
              '',
              blockquote(trimmed),
            ].join('\n');
      const base = mentionBlock === '' ? briefPart : [briefPart, '', mentionBlock].join('\n');
      return withTrailer(base);
    }

    const scaffold =
      'Scaffold the folders, templates, and AI-readable rules to match, using OpenKnowledge.';
    const base =
      trimmed === ''
        ? mentionBlock === ''
          ? `Let's set up a new OpenKnowledge project. ${scaffold}`
          : [`Let's set up a new OpenKnowledge project. ${scaffold}`, '', mentionBlock].join('\n')
        : [
            "I'm setting up a new OpenKnowledge project. Here's what I want to create:",
            '',
            blockquote(trimmed),
            ...(mentionBlock === '' ? [] : ['', mentionBlock]),
            '',
            scaffold,
          ].join('\n');
    return withTrailer(base);
  };

  // Fit the brief against the worst-case (Cursor double-encoded) directive
  // budget — target-agnostic, mirroring `fitInstructionForDirective`. The funnel
  // prepends the skill pointer to this prompt, so the directive budget (which
  // holds back `POINTER_ENCODED_RESERVE`) is the right cap. Mentions + framing
  // are never trimmed.
  const fittedBrief = fitInstruction(
    build,
    description.trim(),
    'cursor',
    DIRECTIVE_INLINE_PROMPT_ENCODED_BUDGET,
  );
  return build(fittedBrief);
}

/**
 * Hard cap on the dispatched URL length, mirrored from the `url` field's Zod
 * schema in `packages/server/src/handoff-dispatch-api.ts`
 * (`z.string().max(4096)`). Core cannot import from server, so the value is
 * duplicated here — the two must change together.
 */
const MAX_HANDOFF_URL_LENGTH = 4096;

/**
 * Headroom held back, out of `MAX_HANDOFF_URL_LENGTH`, for every part of the
 * dispatched URL that is not the encoded prompt — the scheme, the param names
 * and `&` separators, and the encoded project directory. The composer is not
 * given the project directory and so cannot measure that part exactly; this
 * reserve is a deliberate over-estimate (a realistic encoded content-dir path
 * plus the longest fixed text — Cursor's — sits well under 1 KB). Reserving
 * too much only sends a borderline-large selection to locus mode slightly
 * sooner, which is safe degradation; reserving too little risks an over-length
 * URL, which is not.
 */
const URL_OVERHEAD_RESERVE = 1024;

/** Encoded-prompt budget for inline mode; over this the composer falls back
 *  to locus mode. */
const INLINE_PROMPT_ENCODED_BUDGET = MAX_HANDOFF_URL_LENGTH - URL_OVERHEAD_RESERVE;

/**
 * The dispatch funnel (`selectScopedPrompt`) prepends `OK_PROJECT_SKILL_POINTER`
 * to every *directive* prompt AFTER the composer has fit the instruction. So the
 * directive budget must hold back the pointer's worst-case encoded length, or a
 * just-fitting instruction would push the final pointer-prefixed URL over the
 * cap. Measured Cursor-double-encoded (the worst case `fitInstructionForDirective`
 * targets) and derived from the constant itself — no hardcoded length to drift.
 * so the budget accounts for the full dispatched (pointer-prefixed) prompt.
 */
const POINTER_ENCODED_RESERVE = encodedPromptLength(`${OK_PROJECT_SKILL_POINTER} `, 'cursor');
const DIRECTIVE_INLINE_PROMPT_ENCODED_BUDGET =
  INLINE_PROMPT_ENCODED_BUDGET - POINTER_ENCODED_RESERVE;

/**
 * Longest locus anchor — the quoted opening of an oversized selection.
 * Distinctive enough to be a landmark the agent can find in the doc, short
 * enough that the locus prompt never approaches the URL budget.
 */
const LOCUS_ANCHOR_MAX_CHARS = 160;

/** CommonMark minimum fence length. */
const MIN_FENCE_LENGTH = 3;

/**
 * Appended to a user instruction that had to be shortened so the locus prompt
 * stays within the URL budget. The selection is never truncated (locus mode
 * reads it from the doc); the instruction is the only unbounded user input, so
 * it is the lever the budget guard pulls.
 */
const INSTRUCTION_TRUNCATION_MARKER = ' …';

/**
 * Inputs to `composeSelectionPrompt`. The first three mirror the renderer's
 * selection payload; `target` is added so the composer can measure the
 * post-encoding URL length against the right per-target encoding.
 */
interface SelectionPromptInput {
  /** Active doc's path relative to the OK content dir, forward-slash
   *  normalized with the `.md` suffix. Sanitized before interpolation. */
  readonly relativePath: string;
  /** What the user wants done with the passage; the empty string when the
   *  user dispatched without typing an instruction. */
  readonly instruction: string;
  /** The selected passage, already serialized to markdown. */
  readonly selectionMarkdown: string;
  /** Dispatch target — selects the URL encoding. Cursor double-encodes its
   *  prompt param; Claude and Codex single-encode. */
  readonly target: HandoffTarget;
}

/** Length of the longest unbroken run of backtick characters in `s`. */
function longestBacktickRun(s: string): number {
  let longest = 0;
  let run = 0;
  for (const ch of s) {
    if (ch === '`') {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

/**
 * Fence that safely wraps `content`: longer than the longest backtick run
 * inside it, so a fenced code block in the selection cannot close the wrapper
 * early; never shorter than the CommonMark minimum. A best-effort quoting hint
 * to the receiving agent that the wrapped text is material, not instructions —
 * not an enforced boundary.
 */
function fenceFor(content: string): string {
  return '`'.repeat(Math.max(longestBacktickRun(content) + 1, MIN_FENCE_LENGTH));
}

/**
 * Quoted opening of an oversized selection — the landmark the agent uses to
 * locate the full passage in the doc. The selection's first line, capped at
 * `LOCUS_ANCHOR_MAX_CHARS`.
 */
function buildLocusAnchor(selectionMarkdown: string): string {
  const trimmed = selectionMarkdown.trimStart();
  const newlineIdx = trimmed.indexOf('\n');
  const firstLine = newlineIdx === -1 ? trimmed : trimmed.slice(0, newlineIdx);
  // Cap over code points (`Array.from`), not UTF-16 code units: a cut at the
  // limit must never split a surrogate pair into a lone surrogate, which would
  // make the downstream `encodeURIComponent` throw `URIError`. Mirrors
  // `fitInstruction`'s code-point slicing.
  return Array.from(firstLine).slice(0, LOCUS_ANCHOR_MAX_CHARS).join('').trimEnd();
}

/**
 * Post-encoding length of `prompt` once a URL builder threads it into the
 * target's prompt query param. Cursor double-encodes `text=`; Claude (`q=`)
 * and Codex (`prompt=`) single-encode.
 */
function encodedPromptLength(prompt: string, target: HandoffTarget): number {
  const once = encodeURIComponent(prompt);
  return target === 'cursor' ? encodeURIComponent(once).length : once.length;
}

/** Opening sentence — names the doc with the agent CLIs' `@`-mention token. */
function selectionLead(safePath: string): string {
  return `Let's work on the selected passage in @${safePath} using OpenKnowledge.`;
}

/**
 * The user's instruction, labeled and wrapped in a markdown blockquote so the
 * receiving agent reads it as the user's directive rather than as a stray
 * sentence between the lead and the passage. Multi-line instructions stay
 * intact — each line is `> `-prefixed. Empty instructions are still elided.
 */
function instructionLines(instruction: string): readonly string[] {
  const trimmed = instruction.trim();
  if (trimmed === '') return [];
  const quoted = trimmed
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return ['Instruction:', '', quoted, ''];
}

/**
 * Assemble a directive prompt with its instruction block. Shares
 * `instructionLines` with the selection composer so the file / folder / project
 * "Open with AI" directives and the "Edit with AI" selection prompt quote the
 * instruction identically. An empty / whitespace instruction yields the bare
 * directive. Pulled out of `appendInstruction` so the budget guard measures the
 * exact bytes it assembles.
 */
function directiveWithInstruction(directive: string, instruction: string): string {
  const lines = instructionLines(instruction);
  return lines.length === 0 ? directive : [directive, '', ...lines].join('\n').trimEnd();
}

/**
 * Longest prefix of `instruction` whose composed prompt stays within the encoded
 * URL budget for `target`. Shared by the directive ("Open with AI") and selection
 * locus ("Edit with AI") fits — both bound the same unbounded user instruction
 * against the same 4096-char server `z.string().max(4096)` cap, differing only in
 * how the surrounding prompt is composed (`compose`). Returns the instruction
 * unchanged when it already fits, else a marker-suffixed prefix down to the empty
 * string.
 *
 * Slices over code points (`Array.from`), not UTF-16 code units: cutting
 * mid-surrogate-pair (an emoji, an astral CJK glyph) would leave a lone surrogate
 * that makes `encodeURIComponent` throw inside `fits`. Binary search over the
 * prefix length keeps this to a handful of `compose` calls even for a
 * pathologically long paste.
 */
function fitInstruction(
  compose: (instruction: string) => string,
  instruction: string,
  target: HandoffTarget,
  budget: number = INLINE_PROMPT_ENCODED_BUDGET,
): string {
  const fits = (instr: string): boolean => encodedPromptLength(compose(instr), target) <= budget;
  if (fits(instruction)) return instruction;
  const codePoints = Array.from(instruction);
  let lo = 0;
  let hi = codePoints.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = codePoints.slice(0, mid).join('').trimEnd() + INSTRUCTION_TRUNCATION_MARKER;
    if (fits(candidate)) lo = mid;
    else hi = mid - 1;
  }
  const kept = codePoints.slice(0, lo).join('').trimEnd();
  return kept === '' ? '' : kept + INSTRUCTION_TRUNCATION_MARKER;
}

/**
 * Directive-scope fit. Measures against the worst-case Cursor double-encoding so
 * the result is target-agnostic: a prompt that fits double-encoded fits the
 * single-encoded targets (Claude / Codex) too, so the directive composers never
 * need the dispatch target. Over-reserving (trimming a Claude / Codex
 * instruction slightly sooner than its own encoding strictly requires) is safe
 * degradation; an over-length URL is not.
 */
function fitInstructionForDirective(directive: string, instruction: string): string {
  return fitInstruction(
    (instr) => directiveWithInstruction(directive, instr),
    instruction,
    'cursor',
    // Reserve room for the skill pointer the funnel prepends to directive
    // prompts (see `POINTER_ENCODED_RESERVE`) so instruction + directive +
    // pointer together stay within the URL cap.
    DIRECTIVE_INLINE_PROMPT_ENCODED_BUDGET,
  );
}

/**
 * Append the user's instruction block beneath a directive prompt, shortening an
 * oversized instruction so the dispatched URL stays within budget (see
 * `fitInstructionForDirective`). An empty / whitespace / absent instruction
 * returns the bare directive unchanged, so the no-instruction dispatch path
 * stays byte-identical to the path-only prompts.
 */
function appendInstruction(directive: string, instruction: string | undefined): string {
  return directiveWithInstruction(
    directive,
    fitInstructionForDirective(directive, instruction ?? ''),
  );
}

/** Inline transport — the passage embedded verbatim inside a fenced block. */
function composeInline(safePath: string, instruction: string, selectionMarkdown: string): string {
  const fence = fenceFor(selectionMarkdown);
  return [
    selectionLead(safePath),
    '',
    ...instructionLines(instruction),
    'Here is the passage:',
    '',
    fence,
    selectionMarkdown,
    fence,
  ].join('\n');
}

/**
 * Locus transport — a short anchor plus a directive to read the full passage
 * from the doc via OK MCP. No selection content is dropped; the agent resolves
 * it with one MCP read.
 */
function composeLocus(safePath: string, instruction: string, selectionMarkdown: string): string {
  const anchor = buildLocusAnchor(selectionMarkdown);
  const fence = fenceFor(anchor);
  return [
    selectionLead(safePath),
    '',
    ...instructionLines(instruction),
    'The passage begins:',
    '',
    fence,
    anchor,
    fence,
    '',
    `Read the full passage from @${safePath} via the OpenKnowledge MCP server before editing.`,
  ].join('\n');
}

/**
 * Budget fit for the inline composers (selection / ask / assembler). Thin
 * adapter over `fitInstruction` (the shared code-point-safe binary search) at
 * the default inline budget — kept so the selection / ask / assembler call sites
 * read `(instruction, target, compose)` rather than `fitInstruction`'s
 * `(compose, instruction, target)` order.
 */
function fitInstructionToBudget(
  instruction: string,
  target: HandoffTarget,
  compose: (instruction: string) => string,
): string {
  return fitInstruction(compose, instruction, target);
}

/**
 * Selection-scope composer for the editor "Edit with AI" affordance. Produces
 * a prompt naming the doc (as an `@`-mention), the user's instruction (when
 * one was typed), and the selected passage.
 *
 * The passage travels by a hybrid transport chosen per target:
 *
 *   - **Inline** — when the prompt's post-encoding length leaves the URL
 *     within budget, the passage is embedded verbatim in a fenced block whose
 *     fence outlasts any backtick run inside the passage.
 *   - **Locus** — otherwise the prompt carries only a short quoted opening of
 *     the selection plus a directive to read the full passage from the doc via
 *     OK MCP. The selection is never truncated; if an oversized instruction
 *     would still push the locus URL over budget, the instruction (the only
 *     unbounded user input) is shortened so the URL always stays within budget.
 *
 * The choice is target-aware: Cursor double-encodes its prompt param, so the
 * same selection yields a longer URL for Cursor than for Claude / Codex and
 * can cross into locus mode where the others stay inline.
 */
export function composeSelectionPrompt(input: SelectionPromptInput): string {
  // Use the `@`-mention-aware sanitizer here (only): the selection composer
  // interpolates `@${safePath}` without a backtick fence so the receiving
  // agent CLI parses it as a real file-mention, which is whitespace-
  // terminated. The other composers wrap in backticks and use the base
  // sanitizer.
  const safePath = sanitizePathForAtMention(input.relativePath);
  const inline = composeInline(safePath, input.instruction, input.selectionMarkdown);
  if (encodedPromptLength(inline, input.target) <= INLINE_PROMPT_ENCODED_BUDGET) {
    return inline;
  }
  // Oversized selection → locus. The anchor is capped and the passage is read
  // from the doc, so the instruction is the only remaining unbounded input;
  // shorten it if needed so the locus URL also stays within budget.
  const fittedInstruction = fitInstructionToBudget(input.instruction, input.target, (instr) =>
    composeLocus(safePath, instr, input.selectionMarkdown),
  );
  return composeLocus(safePath, fittedInstruction, input.selectionMarkdown);
}

/**
 * The ask-scope prompt body for an already-sanitized doc path. The lead names
 * the doc as an `@`-mention; a non-empty instruction is blockquoted beneath it
 * so the agent reads it as the user's directive. An empty instruction degrades
 * to the bare lead (no dangling empty blockquote) — same same-line trailer
 * shape as the file / folder / project directives. The trailer rides its own
 * line in the instruction case so it stays out of the blockquote rather than
 * fusing onto the user's last line.
 */
function composeAskBody(safePath: string, instruction: string, autoOpen: boolean): string {
  const lead = `Let's work on @${safePath} using OpenKnowledge.`;
  const trailer = autoOpen ? 'Open the OK editor in web view.' : '';
  const trimmed = instruction.trim();
  if (trimmed === '') {
    return trailer === '' ? lead : `${lead} ${trailer}`;
  }
  const quoted = trimmed
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const lines = [lead, '', quoted];
  if (trailer !== '') lines.push('', trailer);
  return lines.join('\n');
}

/**
 * Ask-scope composer for the persistent bottom "Ask AI" composer. Pairs the
 * current doc (named as an `@`-mention) with the user's typed instruction, with
 * no selection — the one doc+freetext shape the directive and selection
 * composers don't cover. Positional signature mirrors the path composers;
 * `target` is taken because the instruction is the only unbounded input and the
 * prompt travels as a `claude:` / `codex:` / `cursor:` deep link.
 *
 * The path uses the `@`-mention-aware sanitizer (as the selection composer
 * does): the path is interpolated as `@${safePath}` without a backtick fence so
 * the receiving agent CLI parses it as a real, whitespace-terminated mention.
 * The instruction is the user's own text for their own agent — there is no
 * privilege boundary to defend, so it is blockquoted but NOT path-sanitized
 * (backticks and punctuation pass through verbatim).
 *
 * `autoOpen` carries the same semantics as `composeFilePrompt`. When an
 * oversized instruction would push the encoded URL over the per-target budget
 * it is shortened (never the path); the URL is never emitted unbounded.
 */
export function composeAskPrompt(
  relativePath: string,
  instruction: string,
  autoOpen: boolean,
  target: HandoffTarget,
): string {
  const safePath = sanitizePathForAtMention(relativePath);
  const fitted = fitInstructionToBudget(instruction, target, (instr) =>
    composeAskBody(safePath, instr, autoOpen),
  );
  return composeAskBody(safePath, fitted, autoOpen);
}

// --- unified handoff prompt assembler ---------------------------------------

/**
 * The "open the OK editor" trailer the directive composers and `composeAskPrompt`
 * append when `autoOpen` is on. Mirrored here for the unified assembler; must
 * stay byte-identical to the literal those composers use (the
 * "outputs differ only by the trailing Open-the-OK-editor directive" test pins
 * the composer side).
 */
const OPEN_EDITOR_DIRECTIVE = 'Open the OK editor in web view.';

/**
 * How a doc-scope selected passage rides into the prompt. The composer decides
 * the kind from the selection's size and the editor surface (not the URL budget):
 *   - `inline` — embed the literal passage in a fence (short, single-line picks).
 *   - `lines`  — a `lines X-Y of @doc` reference the agent reads via MCP (source
 *                mode, where real line numbers exist).
 *   - `anchor` — a bounded opening-line landmark + read-via-MCP directive (rich
 *                text mode, which has no line numbers, or an oversized inline).
 */
export type ComposeSelection =
  | { readonly kind: 'inline'; readonly markdown: string }
  | { readonly kind: 'lines'; readonly startLine: number; readonly endLine: number }
  | { readonly kind: 'anchor'; readonly markdown: string };

/**
 * Doc-scope inputs to `assembleHandoffPrompt` — the active doc is the scope lead
 * (auto `@`-mentioned) and may carry a selected passage. `selection` describes
 * the passage transport; absent means no passage.
 */
interface AssembleDocScopeInput {
  readonly scope: 'doc';
  /** Active doc's path relative to the OK content dir, forward-slash normalized
   *  with the `.md` suffix. Sanitized before interpolation. */
  readonly docRelativePath: string;
  /** Optional selected passage transport (inline / lines / anchor). */
  readonly selection?: ComposeSelection;
  readonly instruction: string;
  /** Ordered explicit `@`-mention paths (workspace-relative). Each is sanitized
   *  and kept; never trimmed by the budget guard. */
  readonly mentions: readonly string[];
  readonly autoOpen: boolean;
  readonly target: HandoffTarget;
}

/**
 * Project-scope inputs to `assembleHandoffPrompt` — no active doc, so no scope
 * lead `@`-mention and no selection. The explicit mentions are the only `@`-paths.
 */
interface AssembleProjectScopeInput {
  readonly scope: 'project';
  readonly instruction: string;
  readonly mentions: readonly string[];
  readonly autoOpen: boolean;
  readonly target: HandoffTarget;
}

/**
 * Folder-scope inputs to `assembleHandoffPrompt` — a folder view is open: the
 * folder is the scope lead (auto `@`-mentioned, mirroring doc scope's lead) but
 * there is no selectable passage. Explicit chip mentions ride on `mentions`. The
 * directive sibling is `composeFolderPrompt`; this compose variant exists so the
 * folder-page "Ask AI" composer preserves the user's typed `@`-mentions (the
 * directive path carries none).
 */
interface AssembleFolderScopeInput {
  readonly scope: 'folder';
  /** Folder's path relative to the OK content dir, forward-slash normalized with
   *  no trailing slash (e.g. `specs/foo`). Sanitized before interpolation. */
  readonly folderRelativePath: string;
  readonly instruction: string;
  /** Ordered explicit `@`-mention paths (workspace-relative). Each is sanitized
   *  and kept; never trimmed by the budget guard. */
  readonly mentions: readonly string[];
  readonly autoOpen: boolean;
  readonly target: HandoffTarget;
}

/**
 * Discriminated input to the unified assembler. `scope` selects the lead and
 * whether a selection passage is admissible (doc only — a selection is read from
 * the active doc, which is the lead).
 */
export type AssembleHandoffPromptInput =
  | AssembleDocScopeInput
  | AssembleProjectScopeInput
  | AssembleFolderScopeInput;

/** `> `-prefix every line so a multi-line instruction reads as one quoted
 *  directive rather than the first line quoting and the rest bleeding into the
 *  agent's instruction stream. */
function blockquote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/** Inline selection block — the passage embedded verbatim in a fence that
 *  outlasts any backtick run inside it. */
function inlineSelectionSegment(selectionMarkdown: string): string {
  const fence = fenceFor(selectionMarkdown);
  return ['Here is the passage:', '', fence, selectionMarkdown, fence].join('\n');
}

/** Locus selection block — a bounded anchor plus a directive to read the full
 *  passage from the doc via OK MCP. No selection content is dropped. */
function locusSelectionSegment(selectionMarkdown: string, safeDocPath: string): string {
  const anchor = buildLocusAnchor(selectionMarkdown);
  const fence = fenceFor(anchor);
  return [
    'The passage begins:',
    '',
    fence,
    anchor,
    fence,
    '',
    `Read the full passage from @${safeDocPath} via the OpenKnowledge MCP server before editing.`,
  ].join('\n');
}

/**
 * Line-range reference for a source-mode selection — names the lines and points
 * the agent at the doc to read via MCP. No passage content is embedded, so it is
 * always within budget.
 */
function linesSelectionSegment(startLine: number, endLine: number, safeDocPath: string): string {
  const range = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
  return `The selected passage is ${range} of @${safeDocPath}. Read it from @${safeDocPath} via the OpenKnowledge MCP server before editing.`;
}

/**
 * The explicit `@`-mention block — a short header plus one sanitized `@path`
 * per line (each on its own line so the agent CLIs read each as a single
 * whitespace-terminated mention). Empty when there are no usable mentions.
 */
function mentionsSegment(mentions: readonly string[]): string {
  const safe = mentions.map((m) => sanitizePathForAtMention(m)).filter((m) => m !== '');
  if (safe.length === 0) return '';
  return ['Also reference:', '', ...safe.map((p) => `@${p}`)].join('\n');
}

/** Scope lead — the doc `@`-mention for doc scope, the folder `@`-mention for
 *  folder scope, the bare project directive for project scope. The folder lead
 *  mirrors `composeFolderPrompt`'s "the `<folder>` folder" framing but threads
 *  it as an `@`-mention (consistent with the doc lead) so the agent CLIs resolve
 *  it as a real reference. */
function scopeLead(input: AssembleHandoffPromptInput): string {
  if (input.scope === 'doc') {
    return `Let's work on @${sanitizePathForAtMention(input.docRelativePath)} using OpenKnowledge.`;
  }
  if (input.scope === 'folder') {
    return `Let's work on the @${sanitizePathForAtMention(input.folderRelativePath)} folder using OpenKnowledge.`;
  }
  return `Let's work on this project using OpenKnowledge.`;
}

/**
 * Join the assembled parts in fixed order: scope lead → instruction → selection
 * → explicit mentions → autoOpen trailer. When the body (instruction, selection,
 * mentions) is entirely empty the trailer rides the lead's own line — matching
 * the bare-directive shape of `composeEmptySpacePrompt` / `composeAskPrompt`'s
 * empty-instruction case (no dangling empty blockquote).
 */
function composeAssembledBlocks(
  lead: string,
  instruction: string,
  selectionSegment: string,
  mentionBlock: string,
  trailer: string,
): string {
  const trimmedInstruction = instruction.trim();
  const hasBody = trimmedInstruction !== '' || selectionSegment !== '' || mentionBlock !== '';
  if (!hasBody) {
    return trailer === '' ? lead : `${lead} ${trailer}`;
  }
  const blocks: string[] = [lead];
  if (trimmedInstruction !== '') blocks.push(blockquote(trimmedInstruction));
  if (selectionSegment !== '') blocks.push(selectionSegment);
  if (mentionBlock !== '') blocks.push(mentionBlock);
  if (trailer !== '') blocks.push(trailer);
  return blocks.join('\n\n');
}

/**
 * Resolve the selection segment from the composer-decided kind. `lines` and
 * `anchor` are already bounded; `inline` embeds the passage verbatim but degrades
 * to a locus anchor if the passage alone (no instruction) would blow the budget.
 */
function selectionSegmentFor(
  selection: ComposeSelection,
  lead: string,
  safeDocPath: string,
  mentionBlock: string,
  trailer: string,
  target: HandoffTarget,
): string {
  if (selection.kind === 'lines') {
    return linesSelectionSegment(selection.startLine, selection.endLine, safeDocPath);
  }
  if (selection.kind === 'anchor') {
    return locusSelectionSegment(selection.markdown, safeDocPath);
  }
  const inlineSegment = inlineSelectionSegment(selection.markdown);
  const inlineWithoutInstruction = composeAssembledBlocks(
    lead,
    '',
    inlineSegment,
    mentionBlock,
    trailer,
  );
  return encodedPromptLength(inlineWithoutInstruction, target) <= INLINE_PROMPT_ENCODED_BUDGET
    ? inlineSegment
    : locusSelectionSegment(selection.markdown, safeDocPath);
}

/**
 * Assemble a doc-scope prompt that carries a selected passage. The selection
 * segment is fixed first (per its kind), then the instruction is fitted around
 * it to the per-target URL budget — the instruction is the only unbounded lever,
 * and mentions are always preserved.
 */
function assembleDocSelectionPrompt(
  input: AssembleDocScopeInput,
  selection: ComposeSelection,
  mentionBlock: string,
  trailer: string,
): string {
  const { target } = input;
  const safeDocPath = sanitizePathForAtMention(input.docRelativePath);
  const lead = `Let's work on @${safeDocPath} using OpenKnowledge.`;
  const selectionSegment = selectionSegmentFor(
    selection,
    lead,
    safeDocPath,
    mentionBlock,
    trailer,
    target,
  );
  const fittedInstruction = fitInstructionToBudget(input.instruction, target, (instr) =>
    composeAssembledBlocks(lead, instr, selectionSegment, mentionBlock, trailer),
  );
  return composeAssembledBlocks(lead, fittedInstruction, selectionSegment, mentionBlock, trailer);
}

/**
 * Unified holistic prompt assembler — composes scope lead + instruction +
 * selection passage + N explicit `@path` mentions in one budgeted pass and fits
 * the WHOLE assembled string to the per-target encoded URL budget. The only
 * unbounded parts are the instruction and the selection passage; the budget
 * guard trims the instruction first (keeping the passage inline) and degrades
 * the selection to a locus anchor only when the passage alone is too large. The
 * short `@path` tokens are always preserved — the guard never appends tokens
 * after fitting, so a per-composer fit can't strand a mention over budget.
 *
 * Generalizes `composeAskPrompt` (doc + instruction), `composeSelectionPrompt`
 * (doc + instruction + passage), and `composeAskProjectPrompt` (project +
 * instruction) into one path that additionally carries explicit mentions. The
 * three single-purpose composers remain for their existing callers; the dispatch
 * layer routes doc-with-mentions, project scope, and selection through here.
 */
export function assembleHandoffPrompt(input: AssembleHandoffPromptInput): string {
  const { target } = input;
  const trailer = input.autoOpen ? OPEN_EDITOR_DIRECTIVE : '';
  const mentionBlock = mentionsSegment(input.mentions);

  if (input.scope === 'doc' && input.selection !== undefined) {
    return assembleDocSelectionPrompt(input, input.selection, mentionBlock, trailer);
  }

  // No selection (project + folder scope always; doc scope without a passage):
  // the instruction is the only unbounded lever. Fit it with the mentions present
  // so the budget accounts for the whole assembled string, not the instruction
  // alone.
  const lead = scopeLead(input);
  const fittedInstruction = fitInstructionToBudget(input.instruction, target, (instr) =>
    composeAssembledBlocks(lead, instr, '', mentionBlock, trailer),
  );
  return composeAssembledBlocks(lead, fittedInstruction, '', mentionBlock, trailer);
}

/**
 * Project-scope ask composer for the bottom "Ask AI" composer with no doc open.
 * Pairs the user's typed instruction with the bare project directive — no doc
 * default, no selection. An empty instruction degrades to the bare project
 * directive (no empty blockquote, no doc `@`-mention). Routes through the unified
 * assembler so an oversized instruction is fitted to the per-target URL budget,
 * mirroring `composeAskPrompt`'s positional `(instruction, autoOpen, target)`
 * signature. `composeEmptySpacePrompt` carries no freetext and `composeCreatePrompt`
 * is create-framed, so neither covers this project + freetext shape.
 */
export function composeAskProjectPrompt(
  instruction: string,
  autoOpen: boolean,
  target: HandoffTarget,
): string {
  return assembleHandoffPrompt({ scope: 'project', instruction, mentions: [], autoOpen, target });
}
