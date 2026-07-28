/**
 * The optional churn survey `ok uninstall` runs once the removal has already
 * succeeded: one reason, an optional note, an optional follow-up address. Only
 * a completed uninstall is a departure worth asking about, and by then there is
 * nothing left to interrupt.
 *
 * Two rules shape everything here. The removal is already done by the time this
 * runs, so nothing in it may fail the command — every failure path continues.
 * And it must stay silent unless a human is actually watching: the desktop
 * cleanup script shells out `ok uninstall --yes`, and a prompt there would hang
 * a detached process forever.
 */

import { createInterface } from 'node:readline/promises';
import {
  hasUninstallFeedbackContent,
  postUninstallFeedback,
  UNINSTALL_FEEDBACK_REASONS,
  type UninstallFeedbackAnswers,
  type UninstallFeedbackReason,
  type UninstallFeedbackResult,
  type UninstallFeedbackSubmission,
} from '@inkeep/open-knowledge-core';
import select from '@inquirer/select';
import { accent, dim } from '../ui/colors.ts';

/** `null` is the skip choice — no slug can stand in for "declined to answer". */
type ReasonChoice = UninstallFeedbackReason | null;

interface UninstallFeedbackGate {
  /** Defaults to the real stdin; inquirer reads it, so it must be interactive. */
  stdinIsTTY?: boolean;
  /** Defaults to the real stdout. Piped means a script is reading us, not a person. */
  stdoutIsTTY?: boolean;
  yes?: boolean;
  json?: boolean;
}

/**
 * Whether a human is present to answer. Both streams must be a terminal —
 * gating on stdout alone would still prompt a caller that piped only its input,
 * and inquirer would then wait on a stream that never delivers a keystroke.
 */
function shouldPromptUninstallFeedback(gate: UninstallFeedbackGate): boolean {
  if (gate.yes === true || gate.json === true) return false;
  const stdin = gate.stdinIsTTY ?? process.stdin.isTTY;
  const stdout = gate.stdoutIsTTY ?? process.stdout.isTTY;
  return stdin === true && stdout === true;
}

/**
 * Where the survey talks to the user. Prompts render on stderr by default so
 * the removal report keeps stdout to itself, matching `confirmDestructive`.
 * Injectable so the prompt sequence itself is testable.
 */
export interface UninstallFeedbackIO {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

async function askOptionalLine(io: Required<UninstallFeedbackIO>, prompt: string): Promise<string> {
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

/**
 * The default prompt sequence. Skipping the reason ends the survey — someone
 * who just said they'd rather not say should not then be asked twice more.
 */
export async function collectUninstallFeedbackAnswers(
  io: UninstallFeedbackIO = {},
): Promise<UninstallFeedbackAnswers> {
  const streams = { input: io.input ?? process.stdin, output: io.output ?? process.stderr };
  // Said before the first question, not beside the email field: the note is
  // just as much of a send, and the answer to "where does this go?" should not
  // arrive after someone has already typed it.
  streams.output.write(dim('\nWhat you share is sent to the OpenKnowledge team.\n'));
  const reason = await select<ReasonChoice>(
    {
      message: 'Before you go, mind sharing why? (optional)',
      // Start on the opt-out so a reflexive Enter can't invent a churn reason.
      default: null,
      // Every reason on screen at once. The default page size is one short of
      // the taxonomy plus the skip row, which would scroll the first reason out
      // of view precisely because the cursor starts at the bottom.
      pageSize: UNINSTALL_FEEDBACK_REASONS.length + 1,
      choices: [
        ...UNINSTALL_FEEDBACK_REASONS.map((option) => ({
          name: option.label,
          value: option.value as ReasonChoice,
        })),
        { name: "Skip, I'd rather not say", value: null },
      ],
    },
    streams,
  );
  if (reason === null) return {};

  const note = await askOptionalLine(streams, dim('Anything else we should know? (optional) '));
  const email = await askOptionalLine(streams, dim('Email, if we may follow up (optional) '));
  return { reason, note: note || undefined, email: email || undefined };
}

export interface UninstallFeedbackPromptDeps extends UninstallFeedbackGate, UninstallFeedbackIO {
  appVersion: string;
  platform: string;
  /** Test hook for the prompt sequence. */
  collect?: () => Promise<UninstallFeedbackAnswers>;
  /** Test hook for the intake transport. */
  submit?: (submission: UninstallFeedbackSubmission) => Promise<UninstallFeedbackResult>;
}

export type UninstallFeedbackOutcome =
  | 'not-prompted'
  | 'skipped'
  | 'submitted'
  | 'undelivered'
  | 'failed';

/**
 * Ask, then file. The returned outcome is diagnostic only — the caller removes
 * OpenKnowledge either way — but it still reports the send honestly rather than
 * calling a dropped POST "submitted".
 */
export async function promptUninstallFeedback(
  deps: UninstallFeedbackPromptDeps,
): Promise<UninstallFeedbackOutcome> {
  if (!shouldPromptUninstallFeedback(deps)) return 'not-prompted';
  let answers: UninstallFeedbackAnswers;
  try {
    answers = await (deps.collect ?? (() => collectUninstallFeedbackAnswers(deps)))();
  } catch {
    // Ctrl-C at a prompt, or a stdin that closed underneath it. Both are
    // external events, and neither may propagate into a removal that has
    // already happened.
    return 'failed';
  }
  if (!hasUninstallFeedbackContent(answers)) return 'skipped';
  // Thank the person, not the transport: the send is best-effort and bounded,
  // so waiting to report on it would either stall the exit or report a lie.
  (deps.output ?? process.stderr).write(`\n${accent('Thank you. We read every response.')}\n\n`);
  // The transport resolves on every failure it can have, so this needs no guard.
  const result = await (deps.submit ?? postUninstallFeedback)({
    ...answers,
    source: 'cli_uninstall',
    appVersion: deps.appVersion,
    platform: deps.platform,
  });
  return result.ok ? 'submitted' : 'undelivered';
}
