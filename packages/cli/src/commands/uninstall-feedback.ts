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

type ReasonChoice = UninstallFeedbackReason | null;

interface UninstallFeedbackGate {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  yes?: boolean;
  json?: boolean;
}

function shouldPromptUninstallFeedback(gate: UninstallFeedbackGate): boolean {
  if (gate.yes === true || gate.json === true) return false;
  const stdin = gate.stdinIsTTY ?? process.stdin.isTTY;
  const stdout = gate.stdoutIsTTY ?? process.stdout.isTTY;
  return stdin === true && stdout === true;
}

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

export async function collectUninstallFeedbackAnswers(
  io: UninstallFeedbackIO = {},
): Promise<UninstallFeedbackAnswers> {
  const streams = { input: io.input ?? process.stdin, output: io.output ?? process.stderr };
  streams.output.write(dim('\nWhat you share is sent to the OpenKnowledge team.\n'));
  const reason = await select<ReasonChoice>(
    {
      message: 'Before you go, mind sharing why? (optional)',
      default: null,
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
  collect?: () => Promise<UninstallFeedbackAnswers>;
  submit?: (submission: UninstallFeedbackSubmission) => Promise<UninstallFeedbackResult>;
}

export type UninstallFeedbackOutcome =
  | 'not-prompted'
  | 'skipped'
  | 'submitted'
  | 'undelivered'
  | 'failed';

export async function promptUninstallFeedback(
  deps: UninstallFeedbackPromptDeps,
): Promise<UninstallFeedbackOutcome> {
  if (!shouldPromptUninstallFeedback(deps)) return 'not-prompted';
  let answers: UninstallFeedbackAnswers;
  try {
    answers = await (deps.collect ?? (() => collectUninstallFeedbackAnswers(deps)))();
  } catch {
    return 'failed';
  }
  if (!hasUninstallFeedbackContent(answers)) return 'skipped';
  (deps.output ?? process.stderr).write(`\n${accent('Thank you. We read every response.')}\n\n`);
  const result = await (deps.submit ?? postUninstallFeedback)({
    ...answers,
    source: 'cli_uninstall',
    appVersion: deps.appVersion,
    platform: deps.platform,
  });
  return result.ok ? 'submitted' : 'undelivered';
}
