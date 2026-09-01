import { CopyPrompt } from '@/components/copy-prompt';

export function VerifyExec({ subject = 'The agent' }: { subject?: string }) {
  return (
    <>
      <CopyPrompt>List the first 5 documents you come across in this project.</CopyPrompt>
      <p>
        {subject} should call the OpenKnowledge <code>exec</code> tool and respond with some of your
        documents.
      </p>
    </>
  );
}
