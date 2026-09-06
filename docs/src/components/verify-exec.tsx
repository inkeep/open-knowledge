import { CopyPrompt } from '@/components/copy-prompt';

const VERIFY_PROMPT = 'List the first 5 documents you come across in this project.';

function verifyExpectation(subject: string): string {
  return `${subject} should call the OpenKnowledge \`exec\` tool and respond with some of your documents.`;
}

export function verifyExecMarkdown(subject: string): string {
  return `> ${VERIFY_PROMPT}\n\n${verifyExpectation(subject)}`;
}

export function VerifyExec({ subject = 'The agent' }: { subject?: string }) {
  return (
    <>
      <CopyPrompt>{VERIFY_PROMPT}</CopyPrompt>
      <p>
        {subject} should call the OpenKnowledge <code>exec</code> tool and respond with some of your
        documents.
      </p>
    </>
  );
}
