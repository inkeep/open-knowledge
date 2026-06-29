import type { HandoffTarget } from './types.ts';

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

function sanitizePathForPrompt(path: string): string {
  return path.replace(PATH_INJECTION_SANITIZE_RE, '_');
}

function sanitizePathForAtMention(path: string): string {
  return path.replace(AT_MENTION_PATH_INJECTION_SANITIZE_RE, '_');
}

export const OK_PROJECT_SKILL_POINTER =
  "This is an OpenKnowledge project: load the `open-knowledge` skill and use the OpenKnowledge MCP tools for all markdown — don't probe for `.ok/` or use native file tools on `.md` / `.mdx`.";

export function withSkillPointer(directive: string): string {
  return `${OK_PROJECT_SKILL_POINTER} ${directive}`;
}

export const OK_TERMINAL_SURFACE_PREAMBLE =
  "You're running in the terminal of the OpenKnowledge desktop app.";

export function composeTerminalBareLaunchPrompt(relativePath: string | null): string {
  const tail =
    relativePath === null
      ? 'Then stop.'
      : `Read \`${sanitizePathForPrompt(relativePath)}\` via the OpenKnowledge MCP server, then stop.`;
  return `${OK_TERMINAL_SURFACE_PREAMBLE} ${OK_PROJECT_SKILL_POINTER} ${tail}`;
}

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

export function composeSkillPrompt(
  skillName: string,
  scope: 'project' | 'global',
  autoOpen: boolean,
): string {
  const safe = sanitizePathForPrompt(skillName);
  const base = `Use your open-knowledge-write-skill skill to author the ${scope} Open Knowledge skill \`${safe}\`. Edit it with the Open Knowledge tools.`;
  return autoOpen ? `${base} Open the OK editor in web view.` : base;
}

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

export function composeEmptySpacePrompt(autoOpen: boolean, instruction?: string): string {
  const base = `Let's work on this project using OpenKnowledge.`;
  const directive = autoOpen ? `${base} Open the OK editor in web view.` : base;
  return appendInstruction(directive, instruction);
}

export type CreateScenario = 'new-project' | 'existing-repo';

export function composeCreatePrompt(
  description: string,
  autoOpen: boolean,
  scenario: CreateScenario,
  mentions: readonly string[],
): string {
  const openTrailer = autoOpen ? ' Open the OK editor in web view.' : '';
  const blockquote = (text: string): string =>
    text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
  const mentionBlock = mentionsSegment(mentions);

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
      return `${base}${openTrailer}`;
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
    return `${base}${openTrailer}`;
  };

  const fittedBrief = fitInstruction(
    build,
    description.trim(),
    'cursor',
    DIRECTIVE_INLINE_PROMPT_ENCODED_BUDGET,
  );
  return build(fittedBrief);
}

const MAX_HANDOFF_URL_LENGTH = 4096;

const URL_OVERHEAD_RESERVE = 1024;

/** Encoded-prompt budget for inline mode; over this the composer falls back
 *  to locus mode. */
const INLINE_PROMPT_ENCODED_BUDGET = MAX_HANDOFF_URL_LENGTH - URL_OVERHEAD_RESERVE;

const POINTER_ENCODED_RESERVE = encodedPromptLength(`${OK_PROJECT_SKILL_POINTER} `, 'cursor');
const DIRECTIVE_INLINE_PROMPT_ENCODED_BUDGET =
  INLINE_PROMPT_ENCODED_BUDGET - POINTER_ENCODED_RESERVE;

const LOCUS_ANCHOR_MAX_CHARS = 160;

const MIN_FENCE_LENGTH = 3;

const INSTRUCTION_TRUNCATION_MARKER = ' …';

interface SelectionPromptInput {
  /** Active doc's path relative to the OK content dir, forward-slash
   *  normalized with the `.md` suffix. Sanitized before interpolation. */
  readonly relativePath: string;
  /** What the user wants done with the passage; the empty string when the
   *  user dispatched without typing an instruction. */
  readonly instruction: string;
  readonly selectionMarkdown: string;
  /** Dispatch target — selects the URL encoding. Cursor double-encodes its
   *  prompt param; Claude and Codex single-encode. */
  readonly target: HandoffTarget;
}

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

function fenceFor(content: string): string {
  return '`'.repeat(Math.max(longestBacktickRun(content) + 1, MIN_FENCE_LENGTH));
}

function buildLocusAnchor(selectionMarkdown: string): string {
  const trimmed = selectionMarkdown.trimStart();
  const newlineIdx = trimmed.indexOf('\n');
  const firstLine = newlineIdx === -1 ? trimmed : trimmed.slice(0, newlineIdx);
  return Array.from(firstLine).slice(0, LOCUS_ANCHOR_MAX_CHARS).join('').trimEnd();
}

function encodedPromptLength(prompt: string, target: HandoffTarget): number {
  const once = encodeURIComponent(prompt);
  return target === 'cursor' ? encodeURIComponent(once).length : once.length;
}

function selectionLead(safePath: string): string {
  return `Let's work on the selected passage in @${safePath} using OpenKnowledge.`;
}

function instructionLines(instruction: string): readonly string[] {
  const trimmed = instruction.trim();
  if (trimmed === '') return [];
  const quoted = trimmed
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return ['Instruction:', '', quoted, ''];
}

function directiveWithInstruction(directive: string, instruction: string): string {
  const lines = instructionLines(instruction);
  return lines.length === 0 ? directive : [directive, '', ...lines].join('\n').trimEnd();
}

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

function fitInstructionForDirective(directive: string, instruction: string): string {
  return fitInstruction(
    (instr) => directiveWithInstruction(directive, instr),
    instruction,
    'cursor',
    DIRECTIVE_INLINE_PROMPT_ENCODED_BUDGET,
  );
}

function appendInstruction(directive: string, instruction: string | undefined): string {
  return directiveWithInstruction(
    directive,
    fitInstructionForDirective(directive, instruction ?? ''),
  );
}

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

function fitInstructionToBudget(
  instruction: string,
  target: HandoffTarget,
  compose: (instruction: string) => string,
): string {
  return fitInstruction(compose, instruction, target);
}

export function composeSelectionPrompt(input: SelectionPromptInput): string {
  const safePath = sanitizePathForAtMention(input.relativePath);
  const inline = composeInline(safePath, input.instruction, input.selectionMarkdown);
  if (encodedPromptLength(inline, input.target) <= INLINE_PROMPT_ENCODED_BUDGET) {
    return inline;
  }
  const fittedInstruction = fitInstructionToBudget(input.instruction, input.target, (instr) =>
    composeLocus(safePath, instr, input.selectionMarkdown),
  );
  return composeLocus(safePath, fittedInstruction, input.selectionMarkdown);
}

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


const OPEN_EDITOR_DIRECTIVE = 'Open the OK editor in web view.';

export type ComposeSelection =
  | { readonly kind: 'inline'; readonly markdown: string }
  | { readonly kind: 'lines'; readonly startLine: number; readonly endLine: number }
  | { readonly kind: 'anchor'; readonly markdown: string };

interface AssembleDocScopeInput {
  readonly scope: 'doc';
  /** Active doc's path relative to the OK content dir, forward-slash normalized
   *  with the `.md` suffix. Sanitized before interpolation. */
  readonly docRelativePath: string;
  readonly selection?: ComposeSelection;
  readonly instruction: string;
  /** Ordered explicit `@`-mention paths (workspace-relative). Each is sanitized
   *  and kept; never trimmed by the budget guard. */
  readonly mentions: readonly string[];
  readonly autoOpen: boolean;
  readonly target: HandoffTarget;
}

interface AssembleProjectScopeInput {
  readonly scope: 'project';
  readonly instruction: string;
  readonly mentions: readonly string[];
  readonly autoOpen: boolean;
  readonly target: HandoffTarget;
}

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

function linesSelectionSegment(startLine: number, endLine: number, safeDocPath: string): string {
  const range = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
  return `The selected passage is ${range} of @${safeDocPath}. Read it from @${safeDocPath} via the OpenKnowledge MCP server before editing.`;
}

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

export function assembleHandoffPrompt(input: AssembleHandoffPromptInput): string {
  const { target } = input;
  const trailer = input.autoOpen ? OPEN_EDITOR_DIRECTIVE : '';
  const mentionBlock = mentionsSegment(input.mentions);

  if (input.scope === 'doc' && input.selection !== undefined) {
    return assembleDocSelectionPrompt(input, input.selection, mentionBlock, trailer);
  }

  const lead = scopeLead(input);
  const fittedInstruction = fitInstructionToBudget(input.instruction, target, (instr) =>
    composeAssembledBlocks(lead, instr, '', mentionBlock, trailer),
  );
  return composeAssembledBlocks(lead, fittedInstruction, '', mentionBlock, trailer);
}

export function composeAskProjectPrompt(
  instruction: string,
  autoOpen: boolean,
  target: HandoffTarget,
): string {
  return assembleHandoffPrompt({ scope: 'project', instruction, mentions: [], autoOpen, target });
}
