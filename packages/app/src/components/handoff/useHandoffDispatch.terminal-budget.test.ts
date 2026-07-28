/**
 * Transport-budget tests for `composeTerminalLaunchPrompt` — the docked-terminal
 * launch path.
 *
 * A prompt budget is a property of the TRANSPORT the prompt travels over, and
 * the two handoff transports differ by orders of magnitude:
 *
 *   - Web deep-link: the dispatched URL is capped at 4096 chars by the server's
 *     `/api/handoff` schema (`handoff-dispatch-api.ts`), so the composers
 *     shorten an oversized instruction to an encoded budget and append the
 *     ` …` truncation marker.
 *   - Docked terminal: the prompt is baked into a PTY argv
 *     (`buildCliLaunchArgString` → `$SHELL -l -i -c '…'`), whose real limit is
 *     the OS ARG_MAX (~1 MB on macOS — the desktop app's only platform).
 *
 * The terminal path must therefore NOT inherit the deep-link URL budget: a
 * long typed instruction survives a terminal launch in full, while the same
 * instruction on the web deep-link path keeps its intentional URL-budget
 * truncation. Selections are never truncated on either transport (locus mode
 * re-reads via MCP).
 *
 * Exercises the real renderer path end-to-end: `buildComposerHandoffInput` →
 * `composeTerminalLaunchPrompt` → `buildCliLaunchArgString` (the composed
 * string is byte-identical to what the PTY receives).
 */

import {
  assembleHandoffPrompt,
  buildCliLaunchArgString,
  composeAskPrompt,
  composeSelectionPrompt,
  shellSingleQuote,
  TERMINAL_CLI_IDS,
  TERMINAL_INLINE_PROMPT_BUDGET,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import type { HandoffDispatchInput } from './useHandoffDispatch';

/** The composer's truncation marker (`INSTRUCTION_TRUNCATION_MARKER` in
 *  `prompt-composer.ts`) — its presence in a composed prompt is the observable
 *  signal that user text was cut. */
const TRUNCATION_MARKER = ' …';

/** macOS ARG_MAX — the terminal transport's real ceiling. The desktop app
 *  (the only surface with a docked terminal) is macOS-only. */
const MACOS_ARG_MAX = 1_048_576;

/**
 * Encoded-prompt budget of the web deep-link transport: the 4096-char URL cap
 * minus the 1024-char overhead reserve. Mirrors `INLINE_PROMPT_ENCODED_BUDGET`
 * in `packages/core/src/handoff/prompt-composer.ts` — the two must change
 * together.
 */
const URL_INLINE_PROMPT_ENCODED_BUDGET = 4096 - 1024;

const workspace = { contentDir: '/Users/u/notes', pathSeparator: '/' as const };

/** Realistic single-line prose (spaces + punctuation, no newlines, no `…`),
 *  so a full-retention assertion can be a simple substring check against the
 *  blockquoted instruction. */
function terminalProse(chars: number): string {
  const unit = 'Please restructure the migration plan, keep the rollback steps, and cite owners. ';
  return unit
    .repeat(Math.ceil(chars / unit.length))
    .slice(0, chars)
    .trimEnd();
}

describe('composeTerminalLaunchPrompt — terminal transport carries long instructions in full', () => {
  test('compose scope: a 40,000-char Ask-AI instruction survives a docked-terminal launch un-truncated for every CLI', async () => {
    const { buildComposerHandoffInput, composeTerminalLaunchPrompt } = await import(
      './useHandoffDispatch'
    );
    const instruction = terminalProse(40_000);
    const input = buildComposerHandoffInput({
      docName: 'plans/migration',
      workspace,
      instruction,
      mentions: [],
    });
    expect(input).not.toBeNull();
    if (input === null) return;
    for (const cli of TERMINAL_CLI_IDS) {
      const prompt = composeTerminalLaunchPrompt(input, cli);
      // The full typed instruction reaches the agent — no loss, no marker.
      expect(prompt).toContain(instruction);
      expect(prompt).not.toContain(TRUNCATION_MARKER);
      // And the resulting PTY argv still fits the transport's real ceiling.
      expect(buildCliLaunchArgString(cli, prompt).length).toBeLessThanOrEqual(MACOS_ARG_MAX);
    }
  });

  test('directive scope: a 40,000-char "Open with AI" instruction survives a terminal launch for claude and cursor', async () => {
    // Cursor is the worst-cased target (its deep-link double-encodes), so it
    // pins that the terminal path must not apply URL-encoding worst-casing at
    // all — the PTY receives raw bytes, not a URL.
    const { composeTerminalLaunchPrompt } = await import('./useHandoffDispatch');
    const instruction = terminalProse(40_000);
    const input: HandoffDispatchInput = {
      docContext: { relativePath: 'plans/migration.md' },
      projectDir: '/proj',
      docPath: '/proj/plans/migration.md',
      instruction,
    };
    for (const cli of ['claude', 'cursor'] as const) {
      const prompt = composeTerminalLaunchPrompt(input, cli);
      expect(prompt).toContain(instruction);
      expect(prompt).not.toContain(TRUNCATION_MARKER);
    }
  });

  test('create scope: a 32,768-char create brief survives a terminal launch un-truncated', async () => {
    const { composeTerminalLaunchPrompt } = await import('./useHandoffDispatch');
    const brief = terminalProse(32_768);
    const input: HandoffDispatchInput = {
      docContext: null,
      createDescription: brief,
      createScenario: 'new-project',
      projectDir: '/proj',
      docPath: '',
    };
    const prompt = composeTerminalLaunchPrompt(input, 'claude');
    expect(prompt).toContain(brief);
    expect(prompt).not.toContain(TRUNCATION_MARKER);
  });

  test('terminal transport stays bounded: a ~950KB instruction is trimmed to TERMINAL_INLINE_PROMPT_BUDGET, marked, and the argv stays under ARG_MAX', async () => {
    // The terminal budget is large but NOT unbounded — an argv over ARG_MAX
    // would make the PTY spawn fail outright. The composer fits the quoted
    // prompt bytes to TERMINAL_INLINE_PROMPT_BUDGET and marks the cut.
    const { buildComposerHandoffInput, composeTerminalLaunchPrompt } = await import(
      './useHandoffDispatch'
    );
    const instruction = terminalProse(950_000);
    const input = buildComposerHandoffInput({
      docName: 'plans/migration',
      workspace,
      instruction,
      mentions: [],
    });
    expect(input).not.toBeNull();
    if (input === null) return;
    const prompt = composeTerminalLaunchPrompt(input, 'claude');
    // The fitted portion (before the funnel-prepended preamble) respects the
    // budget; the launch argv as a whole stays within budget + overhead
    // reserve — far under ARG_MAX.
    expect(new TextEncoder().encode(shellSingleQuote(prompt)).length).toBeLessThanOrEqual(
      TERMINAL_INLINE_PROMPT_BUDGET + 1024,
    );
    expect(buildCliLaunchArgString('claude', prompt).length).toBeLessThanOrEqual(MACOS_ARG_MAX);
    expect(prompt).not.toContain(instruction);
    expect(prompt).toContain(TRUNCATION_MARKER);
    // The trim happened at the terminal budget, not the ~3 KB URL budget.
    expect(prompt.length).toBeGreaterThan(TERMINAL_INLINE_PROMPT_BUDGET - 2_000);
  });
});

describe('web deep-link transport keeps its intentional URL budget', () => {
  test('a 32,768-char instruction on the deep-link ask path is still truncated with the marker, within the encoded budget', () => {
    const instruction = terminalProse(32_768);
    const prompt = composeAskPrompt('plans/migration.md', instruction, true, 'claude-code');
    expect(prompt).toContain(TRUNCATION_MARKER);
    expect(prompt).not.toContain(instruction);
    // Claude single-encodes its `q=` param; the encoded prompt must fit the
    // URL cap minus overhead reserve.
    expect(encodeURIComponent(prompt).length).toBeLessThanOrEqual(URL_INLINE_PROMPT_ENCODED_BUDGET);
  });

  test('a 32,768-char instruction through the deep-link assembler (compose scope, web) is still truncated with the marker', () => {
    const instruction = terminalProse(32_768);
    const prompt = assembleHandoffPrompt({
      scope: 'doc',
      docRelativePath: 'plans/migration.md',
      instruction,
      mentions: [],
      autoOpen: true,
      target: 'claude-code',
    });
    expect(prompt).toContain(TRUNCATION_MARKER);
    expect(prompt).not.toContain(instruction);
    expect(encodeURIComponent(prompt).length).toBeLessThanOrEqual(URL_INLINE_PROMPT_ENCODED_BUDGET);
  });
});

describe('selections are never truncated on either transport', () => {
  test('terminal transport: an oversized anchored selection degrades to a locus anchor + MCP re-read directive — no content loss', async () => {
    const { buildComposerHandoffInput, composeTerminalLaunchPrompt } = await import(
      './useHandoffDispatch'
    );
    const selection = terminalProse(40_000);
    const input = buildComposerHandoffInput({
      docName: 'plans/migration',
      workspace,
      instruction: 'tighten this',
      mentions: [],
      selection: { kind: 'anchor', markdown: selection },
    });
    expect(input).not.toBeNull();
    if (input === null) return;
    const prompt = composeTerminalLaunchPrompt(input, 'claude');
    expect(prompt).toContain('The passage begins:');
    expect(prompt).toContain('Read the full passage from');
    // The passage is re-read from the doc, not inlined-and-cut: only the
    // bounded anchor (first 160 chars) rides in the prompt.
    expect(prompt).not.toContain(selection.slice(0, 500));
    expect(prompt).toContain('tighten this');
  });

  test('web transport: an oversized selection degrades to locus mode — no content loss', () => {
    const selection = terminalProse(40_000);
    const prompt = composeSelectionPrompt({
      relativePath: 'plans/migration.md',
      instruction: 'tighten this',
      selectionMarkdown: selection,
      target: 'claude-code',
    });
    expect(prompt).toContain('The passage begins:');
    expect(prompt).toContain('Read the full passage from');
    expect(prompt).not.toContain(selection.slice(0, 500));
  });
});
