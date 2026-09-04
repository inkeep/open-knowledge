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
import { shellSingleQuote } from './terminal-launch.ts';
import type { HandoffTarget } from './types.ts';

const PATH_INJECTION_SANITIZE_RE = new RegExp(
  '[' +
    '\\u0000-\\u001f' +
    '\\u007f-\\u009f' +
    '\\u200b-\\u200f' +
    '\\u2028-\\u202e' +
    '\\u2060-\\u2069' +
    '\\ufeff' +
    '`' +
    ']+',
  'g',
);

const AT_MENTION_PATH_INJECTION_SANITIZE_RE = new RegExp(
  '[ \\u00a0' +
    '\\u0000-\\u001f' +
    '\\u007f-\\u009f' +
    '\\u200b-\\u200f' +
    '\\u2028-\\u202e' +
    '\\u2060-\\u2069' +
    '\\ufeff' +
    '`' +
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

export const OK_THREAD_SURFACE_PREAMBLE =
  "You're an agent working inside OpenKnowledge, with its MCP tools available to you.";

export function composeThreadBareLaunchPrompt(relativePath: string | null): string {
  const tail =
    relativePath === null
      ? 'Then stop.'
      : `Read \`${sanitizePathForPrompt(relativePath)}\` via the OpenKnowledge MCP server, then stop.`;
  return `${OK_THREAD_SURFACE_PREAMBLE} ${OK_PROJECT_SKILL_POINTER} ${tail}`;
}

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
  transport: PromptTransport = 'url',
): string {
  const safe = sanitizePathForPrompt(relativePath);
  const base = `Let's work on \`${safe}\` using OpenKnowledge.`;
  const directive = autoOpen ? `${base} Open the OK editor in web view.` : base;
  return appendInstruction(directive, instruction, transport);
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
  transport: PromptTransport = 'url',
): string {
  const safe = sanitizePathForPrompt(relativeFolderPath);
  const base = `Let's work on the \`${safe}\` folder using OpenKnowledge.`;
  const directive = autoOpen ? `${base} Open the OK editor in web view.` : base;
  return appendInstruction(directive, instruction, transport);
}

export function composeEmptySpacePrompt(
  autoOpen: boolean,
  instruction?: string,
  transport: PromptTransport = 'url',
): string {
  const base = `Let's work on this project using OpenKnowledge.`;
  const directive = autoOpen ? `${base} Open the OK editor in web view.` : base;
  return appendInstruction(directive, instruction, transport);
}

export type CreateScenario = 'new-project' | 'existing-repo' | 'skill';

export function composeCreatePrompt(
  description: string,
  autoOpen: boolean,
  scenario: CreateScenario,
  mentions: readonly string[],
  transport: PromptTransport = 'url',
): string {
  const trailer = autoOpen ? 'Open the OK editor in web view.' : '';
  const withTrailer = (base: string): string => {
    if (trailer === '') return base;
    return base.includes('\n') ? [base, '', trailer].join('\n') : `${base} ${trailer}`;
  };
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
      return withTrailer(base);
    }

    if (scenario === 'skill') {
      const writeSkill =
        'Use your open-knowledge-write-skill skill to author it with the Open Knowledge tools.';
      const base =
        trimmed === ''
          ? mentionBlock === ''
            ? `Let's create a new Open Knowledge skill. ${writeSkill}`
            : [`Let's create a new Open Knowledge skill. ${writeSkill}`, '', mentionBlock].join(
                '\n',
              )
          : [
              "I want to create a new Open Knowledge skill. Here's what it should do:",
              '',
              blockquote(trimmed),
              ...(mentionBlock === '' ? [] : ['', mentionBlock]),
              '',
              writeSkill,
            ].join('\n');
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

  const fittedBrief = fitInstruction(
    build,
    description.trim(),
    'cursor',
    transport,
    DIRECTIVE_INLINE_PROMPT_ENCODED_BUDGET,
  );
  return build(fittedBrief);
}

const MAX_HANDOFF_URL_LENGTH = 4096;

const URL_OVERHEAD_RESERVE = 1024;

const INLINE_PROMPT_ENCODED_BUDGET = MAX_HANDOFF_URL_LENGTH - URL_OVERHEAD_RESERVE;

const POINTER_ENCODED_RESERVE = encodedPromptLength(`${OK_PROJECT_SKILL_POINTER} `, 'cursor');
const DIRECTIVE_INLINE_PROMPT_ENCODED_BUDGET =
  INLINE_PROMPT_ENCODED_BUDGET - POINTER_ENCODED_RESERVE;

export type PromptTransport = 'url' | 'terminal';

const MAX_TERMINAL_PROMPT_ARG_BYTES = 100 * 1024;

const TERMINAL_OVERHEAD_RESERVE = 1024;

export const TERMINAL_INLINE_PROMPT_BUDGET =
  MAX_TERMINAL_PROMPT_ARG_BYTES - TERMINAL_OVERHEAD_RESERVE;

const UTF8_ENCODER = new TextEncoder();

function promptTransportLength(
  prompt: string,
  target: HandoffTarget,
  transport: PromptTransport,
): number {
  if (transport === 'terminal') {
    return UTF8_ENCODER.encode(shellSingleQuote(prompt)).length;
  }
  return encodedPromptLength(prompt, target);
}

function transportBudget(transport: PromptTransport, urlBudget: number): number {
  return transport === 'terminal' ? TERMINAL_INLINE_PROMPT_BUDGET : urlBudget;
}

const LOCUS_ANCHOR_MAX_CHARS = 160;

const MIN_FENCE_LENGTH = 3;

const INSTRUCTION_TRUNCATION_MARKER = ' …';

interface SelectionPromptInput {
  readonly relativePath: string;
  readonly instruction: string;
  readonly selectionMarkdown: string;
  readonly target: HandoffTarget;
  readonly transport?: PromptTransport;
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
  transport: PromptTransport = 'url',
  urlBudget: number = INLINE_PROMPT_ENCODED_BUDGET,
): string {
  const budget = transportBudget(transport, urlBudget);
  const fits = (instr: string): boolean =>
    promptTransportLength(compose(instr), target, transport) <= budget;
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

function fitInstructionForDirective(
  directive: string,
  instruction: string,
  transport: PromptTransport,
): string {
  return fitInstruction(
    (instr) => directiveWithInstruction(directive, instr),
    instruction,
    'cursor',
    transport,
    DIRECTIVE_INLINE_PROMPT_ENCODED_BUDGET,
  );
}

function appendInstruction(
  directive: string,
  instruction: string | undefined,
  transport: PromptTransport,
): string {
  return directiveWithInstruction(
    directive,
    fitInstructionForDirective(directive, instruction ?? '', transport),
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
  transport: PromptTransport = 'url',
): string {
  return fitInstruction(compose, instruction, target, transport);
}

export function composeSelectionPrompt(input: SelectionPromptInput): string {
  const safePath = sanitizePathForAtMention(input.relativePath);
  const transport = input.transport ?? 'url';
  const inline = composeInline(safePath, input.instruction, input.selectionMarkdown);
  if (
    promptTransportLength(inline, input.target, transport) <=
    transportBudget(transport, INLINE_PROMPT_ENCODED_BUDGET)
  ) {
    return inline;
  }
  const fittedInstruction = fitInstructionToBudget(
    input.instruction,
    input.target,
    (instr) => composeLocus(safePath, instr, input.selectionMarkdown),
    transport,
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
  transport: PromptTransport = 'url',
): string {
  const safePath = sanitizePathForAtMention(relativePath);
  const fitted = fitInstructionToBudget(
    instruction,
    target,
    (instr) => composeAskBody(safePath, instr, autoOpen),
    transport,
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
  readonly docRelativePath: string;
  readonly selection?: ComposeSelection;
  readonly instruction: string;
  readonly mentions: readonly string[];
  readonly autoOpen: boolean;
  readonly target: HandoffTarget;
  readonly transport?: PromptTransport;
}

interface AssembleProjectScopeInput {
  readonly scope: 'project';
  readonly instruction: string;
  readonly mentions: readonly string[];
  readonly autoOpen: boolean;
  readonly target: HandoffTarget;
  readonly transport?: PromptTransport;
}

interface AssembleFolderScopeInput {
  readonly scope: 'folder';
  readonly folderRelativePath: string;
  readonly instruction: string;
  readonly mentions: readonly string[];
  readonly autoOpen: boolean;
  readonly target: HandoffTarget;
  readonly transport?: PromptTransport;
}

export type AssembleHandoffPromptInput =
  | AssembleDocScopeInput
  | AssembleProjectScopeInput
  | AssembleFolderScopeInput;

function blockquote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function inlineSelectionSegment(selectionMarkdown: string): string {
  const fence = fenceFor(selectionMarkdown);
  return ['Here is the passage:', '', fence, selectionMarkdown, fence].join('\n');
}

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
  transport: PromptTransport,
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
  return promptTransportLength(inlineWithoutInstruction, target, transport) <=
    transportBudget(transport, INLINE_PROMPT_ENCODED_BUDGET)
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
  const transport = input.transport ?? 'url';
  const safeDocPath = sanitizePathForAtMention(input.docRelativePath);
  const lead = `Let's work on @${safeDocPath} using OpenKnowledge.`;
  const selectionSegment = selectionSegmentFor(
    selection,
    lead,
    safeDocPath,
    mentionBlock,
    trailer,
    target,
    transport,
  );
  const fittedInstruction = fitInstructionToBudget(
    input.instruction,
    target,
    (instr) => composeAssembledBlocks(lead, instr, selectionSegment, mentionBlock, trailer),
    transport,
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
  const fittedInstruction = fitInstructionToBudget(
    input.instruction,
    target,
    (instr) => composeAssembledBlocks(lead, instr, '', mentionBlock, trailer),
    input.transport ?? 'url',
  );
  return composeAssembledBlocks(lead, fittedInstruction, '', mentionBlock, trailer);
}

export function composeAskProjectPrompt(
  instruction: string,
  autoOpen: boolean,
  target: HandoffTarget,
  transport: PromptTransport = 'url',
): string {
  return assembleHandoffPrompt({
    scope: 'project',
    instruction,
    mentions: [],
    autoOpen,
    target,
    transport,
  });
}

export interface LintFixPromptInput {
  readonly relativePath: string;
  readonly source: string;
  readonly code: string;
  readonly ruleAlias?: string;
  readonly message: string;
  readonly line: number;
  readonly column: number;
  readonly lineText?: string;
}

export function composeLintFixPrompt(input: LintFixPromptInput): string {
  const safePath = sanitizePathForAtMention(input.relativePath);
  const rule =
    input.ruleAlias === undefined
      ? `${input.source}/${input.code}`
      : `${input.source}/${input.code} (${input.ruleAlias})`;
  const lines: string[] = [
    `Fix this lint problem in @${safePath} using OpenKnowledge.`,
    '',
    `Problem: ${rule} at line ${input.line}, column ${input.column}:`,
    '',
    blockquote(input.message.trim()),
  ];
  const lineText = input.lineText ?? '';
  if (lineText.trim() !== '') {
    const fence = fenceFor(lineText);
    lines.push('', `Line ${input.line} reads:`, '', fence, lineText, fence);
  }
  lines.push(
    '',
    `Edit @${safePath} via the OpenKnowledge MCP server, then re-lint it to confirm the problem is resolved.`,
  );
  return lines.join('\n');
}

export function composeFixAllProblemsPrompt(relativePath: string | null): string {
  if (relativePath === null) {
    return [
      "Fix every problem across this project's documents using OpenKnowledge.",
      '',
      "Run the `audit` tool for the current list of lint violations and broken links, then work file by file — the `lint` tool with `fix: true` clears one document's mechanically-fixable problems at a time — and re-audit until it reports no problems.",
    ].join('\n');
  }
  const safePath = sanitizePathForAtMention(relativePath);
  return [
    `Fix every problem in @${safePath} using OpenKnowledge.`,
    '',
    `Run the \`audit\` tool scoped to it for the current list of lint violations and broken links, then fix each one — the \`lint\` tool with \`fix: true\` clears the mechanically-fixable ones — and re-audit @${safePath} until it reports no problems.`,
  ].join('\n');
}
